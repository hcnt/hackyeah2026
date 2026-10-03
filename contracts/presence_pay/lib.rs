use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};

// Program ID na devnecie (musi się zgadzać z adresem, pod który deployujemy).
// UWAGA: ta wersja zmienia układ kont Event (lista oracli + próg) i zastępuje Receipt kontem Sighting,
// więc wymaga ŚWIEŻEGO deployu pod NOWYM program id.
// Poniższy id to STARY program (4Yhph…), który zostaje na devnecie, ale jest zastąpiony.
// TODO po deployu: wpisać tu nowy program id (oraz w idl.json, README.md i PRESENCE_PROGRAM_ID backendu).
declare_id!("4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf");

/// Maksymalna liczba oracli w evencie (M-of-N, N ≤ 3).
pub const MAX_ORACLES: usize = 3;
/// Przerwa (w sekundach czasu łańcucha) między dwoma kolejnymi zgłoszeniami tego samego portfela,
/// po której liczenie obecności zaczyna się od nowa (osoba wyszła i wróciła).
pub const SIGHTING_GAP_SECS: i64 = 60;
/// Rejestr oracli: maksymalna długość nazwy i adresu API (w bajtach UTF-8).
pub const MAX_ORACLE_NAME: usize = 32;
pub const MAX_ORACLE_URL: usize = 128;
/// Ed25519SigVerify: nagłówek (liczba podpisów + wypełnienie) i 7 offsetów u16 na każdy podpis.
const ED25519_HEADER: usize = 2;
const ED25519_OFFSETS: usize = 14;

#[program]
pub mod presence_pay {
    use super::*;

    /// Raz po deployu. Ustawia treasury i opłatę platformy dla przyszłych eventów.
    /// Oracle nie są globalne: każdy event ma własną listę, wybraną przez organizatora.
    pub fn init_config(ctx: Context<InitConfig>, treasury: Pubkey, fee: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury = treasury;
        cfg.fee = fee;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin może zmienić treasury / opłatę. Dotyczy to TYLKO eventów utworzonych później:
    /// każdy event zamraża treasury i opłatę przy utworzeniu, więc trwające eventy się nie zmieniają.
    pub fn update_config(ctx: Context<UpdateConfig>, treasury: Pubkey, fee: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.treasury = treasury;
        cfg.fee = fee;
        Ok(())
    }

    /// Organizator tworzy event z warunkami i wpłaca cały budżet do konta eventu (vault).
    /// Organizator wybiera 1..=3 oracli i próg `threshold` (ilu RÓŻNYCH oracli musi zgłosić portfel).
    /// Oracle, próg, treasury, opłata, nagroda, limit i min_seen_secs są zamrożone na cały event.
    #[allow(clippy::too_many_arguments)]
    pub fn create_event(
        ctx: Context<CreateEvent>,
        event_id: u64,
        oracles: Vec<Pubkey>,
        threshold: u8,
        start: i64,
        end: i64,
        reward: u64,
        max_paid: u32,
        min_seen_secs: u32,
    ) -> Result<()> {
        require!(end > start, PresenceError::BadTimes);
        require!(reward > 0 && max_paid > 0, PresenceError::BadAmounts);
        require!(!oracles.is_empty() && oracles.len() <= MAX_ORACLES, PresenceError::BadOracles);
        for (i, o) in oracles.iter().enumerate() {
            require!(*o != Pubkey::default(), PresenceError::BadOracles);
            require!(!oracles[..i].contains(o), PresenceError::BadOracles);
        }
        require!(threshold >= 1 && threshold as usize <= oracles.len(), PresenceError::BadThreshold);

        let fee = ctx.accounts.config.fee;
        let budget = reward
            .checked_add(fee)
            .and_then(|per| per.checked_mul(max_paid as u64))
            .ok_or(PresenceError::Overflow)?;

        // Przelew budżetu: organizator -> konto eventu (vault).
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.organizer.key(),
            &ctx.accounts.event.key(),
            budget,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.organizer.to_account_info(),
                ctx.accounts.event.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let ev = &mut ctx.accounts.event;
        ev.organizer = ctx.accounts.organizer.key();
        ev.oracles = [Pubkey::default(); MAX_ORACLES];
        ev.oracles[..oracles.len()].copy_from_slice(&oracles);
        ev.oracle_count = oracles.len() as u8;
        ev.threshold = threshold;
        ev.treasury = ctx.accounts.config.treasury; // zamrożone jak fee
        ev.event_id = event_id;
        ev.start = start;
        ev.end = end;
        ev.reward = reward;
        ev.fee = fee; // zamrożona opłata, późniejsza zmiana w config jej nie dotyczy
        ev.max_paid = max_paid;
        ev.paid_count = 0;
        ev.min_seen_secs = min_seen_secs;
        ev.bump = ctx.bumps.event;
        Ok(())
    }

    /// Przed startem organizator może przesunąć czasy (kwoty są zablokowane).
    pub fn update_event_times(ctx: Context<OrganizerEvent>, start: i64, end: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ev = &mut ctx.accounts.event;
        require!(now < ev.start, PresenceError::AlreadyStarted);
        require!(end > start, PresenceError::BadTimes);
        ev.start = start;
        ev.end = end;
        Ok(())
    }

    /// Oracle jest tylko CZUJNIKIEM: zgłasza fakt "widzę teraz portfel X". O wypłacie decyduje program,
    /// według reguł zamrożonych w evencie, na zegarze łańcucha:
    ///   - zgłoszenie od RÓŻNYCH oracli z listy eventu: co najmniej `threshold` (M-of-N),
    ///   - czas obecności `last_seen - first_seen >= min_seen_secs` (przerwa > SIGHTING_GAP_SECS zeruje licznik),
    ///   - okno `start <= now <= end`, limit `max_paid`, jedna wypłata na portfel (flaga `paid`).
    /// `min_seen_secs = 0` przy `threshold = 1` wypłaca już przy pierwszym zgłoszeniu.
    /// Zgłoszenia po wypłacie są niczym (Ok, bez zmian), więc oracle może je bezpiecznie ponawiać.
    ///
    /// Każde zgłoszenie musi nieść zgodę uczestnika: instrukcja tuż PRZED nią w tej samej transakcji to weryfikacja
    /// ed25519 (natywny program Solany) podpisu portfela uczestnika pod wiadomością dołączenia do TEGO eventu
    /// (zob. check_join_proof). Oracle nie może więc zgłosić portfela, który się nie zapisał: nie podrobi podpisu.
    pub fn report_sighting(ctx: Context<ReportSighting>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ev = &ctx.accounts.event;
        let oracle = ctx.accounts.oracle.key();
        let slot = ev.oracles[..ev.oracle_count as usize]
            .iter()
            .position(|o| *o == oracle)
            .ok_or(PresenceError::NotOracle)?;
        check_join_proof(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.event.key(),
            &ctx.accounts.attendee.key(),
        )?;
        require!(now >= ev.start, PresenceError::NotStarted);
        require!(now <= ev.end, PresenceError::Ended);

        let threshold = ev.threshold;
        let min_seen = ev.min_seen_secs as i64;
        let event_end = ev.end;

        let s = &mut ctx.accounts.sighting;
        if s.paid {
            return Ok(());
        }
        // Nowe konto (init_if_needed wyzerowało dane): payer nigdy nie jest Pubkey::default() po utworzeniu.
        let is_new = s.payer == Pubkey::default();
        if is_new {
            s.payer = oracle;
            s.event_end = event_end; // `end` nie zmieni się już: update_event_times działa tylko przed startem
            s.bump = ctx.bumps.sighting;
        }
        if is_new || now - s.last_seen > SIGHTING_GAP_SECS {
            s.first_seen = now;
            s.reporters = 0;
        }
        s.last_seen = now;
        s.reporters |= 1u8 << slot;

        let enough_oracles = s.reporters.count_ones() >= threshold as u32;
        let long_enough = s.last_seen - s.first_seen >= min_seen;
        if !(enough_oracles && long_enough) {
            return Ok(());
        }

        let ev = &mut ctx.accounts.event;
        // Cała transakcja się wycofuje, więc backend dostaje jasny sygnał, że nie ma po co ponawiać.
        require!(ev.paid_count < ev.max_paid, PresenceError::CapReached);
        let reward = ev.reward;
        let fee = ev.fee;
        ev.paid_count += 1;
        // Flaga ustawiona PRZED przelewem i sprawdzana na początku: ochrona przed podwójną wypłatą.
        ctx.accounts.sighting.paid = true;

        // Konto eventu ma dane, więc lamporty przesuwamy bezpośrednio (nie przez System Program).
        let total = reward.checked_add(fee).ok_or(PresenceError::Overflow)?;
        ctx.accounts.event.sub_lamports(total)?;
        ctx.accounts.attendee.add_lamports(reward)?;
        ctx.accounts.treasury.add_lamports(fee)?;

        emit!(AttendeePaid {
            event: ctx.accounts.event.key(),
            attendee: ctx.accounts.attendee.key(),
            reward,
        });
        Ok(())
    }

    /// Organizator zabiera resztę budżetu: po końcu eventu albo przed startem (anulowanie).
    /// Konto eventu jest zamykane, cały pozostały SOL (z rentem) wraca do organizatora.
    pub fn withdraw_remaining(ctx: Context<WithdrawRemaining>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ev = &ctx.accounts.event;
        require!(now < ev.start || now > ev.end, PresenceError::EventRunning);
        Ok(())
    }

    /// Po końcu eventu oracle, który zapłacił rent konta Sighting, zamyka je i odzyskuje rent.
    /// Koniec eventu jest zapisany w Sighting, więc działa też po withdraw_remaining (konto Event już nie istnieje).
    pub fn close_sighting(ctx: Context<CloseSighting>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now > ctx.accounts.sighting.event_end, PresenceError::EventRunning);
        Ok(())
    }

    // ---------- Rejestr oracli ----------
    // Każdy oracle publikuje na łańcuchu swoją nazwę i adres API (konto OracleInfo, PDA ["oracle", klucz]).
    // Widget uczestnika czyta stąd adresy WSZYSTKICH oracli eventu i wysyła zgłoszenie (selfie) do każdego z nich,
    // więc to nie nasze API decyduje, z którymi oraclami rozmawia uczestnik. Rejestr nie wpływa na wypłaty.

    /// Oracle rejestruje się raz (sam płaci rent): nazwa 1..=32 bajtów, url do 128 bajtów, http(s)://.
    pub fn register_oracle(ctx: Context<RegisterOracle>, name: String, url: String) -> Result<()> {
        check_oracle_info(&name, &url)?;
        let info = &mut ctx.accounts.oracle_info;
        info.oracle = ctx.accounts.oracle.key();
        info.name = name;
        info.url = url;
        info.bump = ctx.bumps.oracle_info;
        Ok(())
    }

    /// Tylko sam oracle może zmienić swoją nazwę i adres.
    pub fn update_oracle(ctx: Context<UpdateOracle>, name: String, url: String) -> Result<()> {
        check_oracle_info(&name, &url)?;
        let info = &mut ctx.accounts.oracle_info;
        info.name = name;
        info.url = url;
        Ok(())
    }

    /// Oracle usuwa swój wpis; rent wraca do niego.
    pub fn close_oracle(_ctx: Context<CloseOracle>) -> Result<()> {
        Ok(())
    }
}

/// Zgoda uczestnika na łańcuchu. Instrukcja tuż przed bieżącą musi być Ed25519SigVerify z jednym podpisem, którego
/// klucz, podpis i wiadomość leżą w danych TEJ instrukcji (indeksy u16::MAX), bo tylko wtedy bajty czytane tutaj są
/// tymi, które natywny program zweryfikował (inaczej offsety mogłyby wskazać dane z innej instrukcji).
/// Klucz = portfel uczestnika, a wiadomość zaczyna się od nagłówka dołączenia z widgetu (signatures.py w backendzie):
///   "Attend Now\nAction: join\nEvent: <event>\nWallet: <attendee>\n"  (dalej Consent i Time, nie sprawdzane).
/// Podpis "leave" lub dla innego eventu/portfela się nie zgadza. Ograniczenie: rezygnacja (leave) nie trafia na
/// łańcuch, więc podpis dołączenia pozostaje ważny do końca eventu.
fn check_join_proof(instructions: &AccountInfo, event: &Pubkey, attendee: &Pubkey) -> Result<()> {
    let current = load_current_index_checked(instructions)? as usize;
    require!(current > 0, PresenceError::BadJoinProof);
    let ix = load_instruction_at_checked(current - 1, instructions)?;
    require!(ix.program_id == ed25519_program::ID, PresenceError::BadJoinProof);
    let data = &ix.data;
    require!(data.len() >= ED25519_HEADER + ED25519_OFFSETS && data[0] == 1, PresenceError::BadJoinProof);

    let u16_at = |i: usize| u16::from_le_bytes([data[ED25519_HEADER + 2 * i], data[ED25519_HEADER + 2 * i + 1]]);
    // signature_offset, signature_ix, pubkey_offset, pubkey_ix, message_offset, message_size, message_ix
    let (pubkey_off, msg_off, msg_len) = (u16_at(2) as usize, u16_at(4) as usize, u16_at(5) as usize);
    require!(
        u16_at(1) == u16::MAX && u16_at(3) == u16::MAX && u16_at(6) == u16::MAX,
        PresenceError::BadJoinProof
    );
    let signer = data.get(pubkey_off..pubkey_off + 32).ok_or(PresenceError::BadJoinProof)?;
    let message = data.get(msg_off..msg_off + msg_len).ok_or(PresenceError::BadJoinProof)?;
    require!(signer == attendee.as_ref(), PresenceError::BadJoinProof);

    let expected = format!("Attend Now\nAction: join\nEvent: {event}\nWallet: {attendee}\n");
    require!(message.starts_with(expected.as_bytes()), PresenceError::BadJoinProof);
    Ok(())
}

fn check_oracle_info(name: &str, url: &str) -> Result<()> {
    require!(!name.is_empty() && name.len() <= MAX_ORACLE_NAME, PresenceError::BadName);
    require!(!name.chars().any(char::is_control), PresenceError::BadName);
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or(PresenceError::BadUrl)?;
    require!(url.len() <= MAX_ORACLE_URL, PresenceError::BadUrl);
    // Coś po schemacie, bez spacji i znaków sterujących (adres trafia wprost do fetch() w widgecie).
    require!(!rest.is_empty() && !rest.chars().any(|c| c.is_whitespace() || c.is_control()), PresenceError::BadUrl);
    Ok(())
}

// ---------- Konta (dane) ----------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Event {
    pub organizer: Pubkey,
    pub oracles: [Pubkey; MAX_ORACLES], // klucze, które mogą zgłaszać obecność; nieużyte = Pubkey::default()
    pub oracle_count: u8,
    pub threshold: u8,    // ilu różnych oracli musi zgłosić portfel, zanim program wypłaci
    pub treasury: Pubkey, // odbiorca opłaty, zamrożony z Config przy utworzeniu
    pub event_id: u64,
    pub start: i64,
    pub end: i64,
    pub reward: u64,
    pub fee: u64,
    pub max_paid: u32,
    pub paid_count: u32,
    pub min_seen_secs: u32, // wymagany czas obecności, liczony przez program na zegarze łańcucha
    pub bump: u8,
}

/// Obecność jednego portfela na jednym evencie. `paid` = ochrona przed podwójną wypłatą.
#[account]
#[derive(InitSpace)]
pub struct Sighting {
    pub first_seen: i64, // początek bieżącego ciągu zgłoszeń (zegar łańcucha)
    pub last_seen: i64,
    pub reporters: u8, // maska bitowa po indeksie oracla w event.oracles
    pub paid: bool,
    pub payer: Pubkey, // oracle, który zapłacił rent; tylko on może zamknąć konto
    pub event_end: i64, // kopia event.end, żeby close_sighting działał po zamknięciu eventu
    pub bump: u8,
}

/// Wpis oracla w rejestrze: gdzie widget ma wysłać zgłoszenie uczestnika. PDA ["oracle", oracle].
#[account]
#[derive(InitSpace)]
pub struct OracleInfo {
    pub oracle: Pubkey,
    #[max_len(32)]
    pub name: String, // nazwa pokazywana uczestnikowi w zgodzie, np. "OnSight"
    #[max_len(128)]
    pub url: String, // bazowy adres API oracla, np. "https://hackyeah.kindhome.io"
    pub bump: u8,
}

// ---------- Listy kont dla instrukcji ----------

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(event_id: u64)]
pub struct CreateEvent<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = organizer,
        space = 8 + Event::INIT_SPACE,
        seeds = [b"event", organizer.key().as_ref(), &event_id.to_le_bytes()],
        bump
    )]
    pub event: Account<'info, Event>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OrganizerEvent<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer)]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct ReportSighting<'info> {
    /// Musi być jednym z event.oracles (sprawdzane w instrukcji: NotOracle). Płaci rent konta Sighting.
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(mut, has_one = treasury)]
    pub event: Account<'info, Event>,
    // Wymaga funkcji `init-if-needed` w anchor-lang (Cargo.toml). Ponowne utworzenie po close_sighting
    // jest niemożliwe: close działa dopiero po końcu eventu, a zgłoszenia tylko do końca.
    #[account(
        init_if_needed,
        payer = oracle,
        space = 8 + Sighting::INIT_SPACE,
        seeds = [b"sighting", event.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub sighting: Account<'info, Sighting>,
    /// CHECK: tylko odbiorca SOL, dowolny portfel
    #[account(mut)]
    pub attendee: UncheckedAccount<'info>,
    /// CHECK: sprawdzany przez has_one na event
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: sysvar Instructions (adres sprawdzany); stąd czytamy weryfikację podpisu uczestnika
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawRemaining<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer, close = organizer)]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct CloseSighting<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, close = payer, has_one = payer)]
    pub sighting: Account<'info, Sighting>,
}

#[derive(Accounts)]
pub struct RegisterOracle<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        init,
        payer = oracle,
        space = 8 + OracleInfo::INIT_SPACE,
        seeds = [b"oracle", oracle.key().as_ref()],
        bump
    )]
    pub oracle_info: Account<'info, OracleInfo>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle)]
    pub oracle_info: Account<'info, OracleInfo>,
}

#[derive(Accounts)]
pub struct CloseOracle<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(mut, has_one = oracle, close = oracle)]
    pub oracle_info: Account<'info, OracleInfo>,
}

// ---------- Eventy i błędy ----------

#[event]
pub struct AttendeePaid {
    pub event: Pubkey,
    pub attendee: Pubkey,
    pub reward: u64,
}

// Nowe błędy dopisujemy NA KOŃCU: kody (6000 + indeks) istniejących wariantów nie mogą się zmienić.
#[error_code]
pub enum PresenceError {
    #[msg("End must be after start")]
    BadTimes,
    #[msg("Reward and max attendees must be > 0")]
    BadAmounts,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Event already started")]
    AlreadyStarted,
    #[msg("Event has not started yet")]
    NotStarted,
    #[msg("Event has ended")]
    Ended,
    #[msg("Max attendees already paid")]
    CapReached,
    #[msg("Not allowed while the event is running")]
    EventRunning,
    #[msg("Oracles must be 1 to 3 distinct, non-default keys")]
    BadOracles,
    #[msg("Threshold must be between 1 and the number of oracles")]
    BadThreshold,
    #[msg("Signer is not one of this event's oracles")]
    NotOracle,
    #[msg("Oracle name must be 1 to 32 bytes, no control characters")]
    BadName,
    #[msg("Oracle url must start with https:// or http://, be at most 128 bytes, no spaces")]
    BadUrl,
    #[msg("Report must follow an ed25519 check of the attendee's signed join message for this event")]
    BadJoinProof,
}
