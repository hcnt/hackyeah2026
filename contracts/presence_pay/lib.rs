    use anchor_lang::prelude::*;

// Program ID na devnecie (musi się zgadzać z adresem, pod który deployujemy).
declare_id!("4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf");

#[program]
pub mod presence_pay {
    use super::*;

    /// Raz po deployu. Ustawia klucz oracle (backend), treasury i opłatę platformy.
    pub fn init_config(ctx: Context<InitConfig>, oracle: Pubkey, treasury: Pubkey, fee: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.oracle = oracle;
        cfg.treasury = treasury;
        cfg.fee = fee;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin może podmienić oracle / treasury / opłatę (np. nowy klucz backendu).
    pub fn update_config(ctx: Context<UpdateConfig>, oracle: Pubkey, treasury: Pubkey, fee: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.oracle = oracle;
        cfg.treasury = treasury;
        cfg.fee = fee;
        Ok(())
    }

    /// Organizator tworzy event z warunkami i wpłaca cały budżet do konta eventu (vault).
    pub fn create_event(
        ctx: Context<CreateEvent>,
        event_id: u64,
        start: i64,
        end: i64,
        reward: u64,
        max_paid: u32,
        min_seen_secs: u32,
    ) -> Result<()> {
        require!(end > start, PresenceError::BadTimes);
        require!(reward > 0 && max_paid > 0, PresenceError::BadAmounts);

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

    /// Wywołuje TYLKO oracle (backend), gdy uczestnik spełnił warunki.
    /// Program pilnuje: okna czasowego, limitu wypłat i jednej wypłaty na portfel.
    pub fn pay_attendee(ctx: Context<PayAttendee>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ev = &mut ctx.accounts.event;
        require!(now >= ev.start, PresenceError::NotStarted);
        require!(now <= ev.end, PresenceError::Ended);
        require!(ev.paid_count < ev.max_paid, PresenceError::CapReached);

        let reward = ev.reward;
        let fee = ev.fee;
        ev.paid_count += 1;

        // Konto eventu ma dane, więc lamporty przesuwamy bezpośrednio (nie przez System Program).
        ctx.accounts.event.sub_lamports(reward + fee)?;
        ctx.accounts.attendee.add_lamports(reward)?;
        ctx.accounts.treasury.add_lamports(fee)?;

        // Utworzenie receipt (init) to ochrona przed podwójną wypłatą:
        // drugie wywołanie dla tej samej pary event+portfel padnie, bo konto już istnieje.
        let receipt = &mut ctx.accounts.receipt;
        receipt.event_end = ctx.accounts.event.end;
        receipt.bump = ctx.bumps.receipt;

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

    /// Po końcu eventu oracle zamyka receipty i odzyskuje rent.
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now > ctx.accounts.receipt.event_end, PresenceError::EventRunning);
        Ok(())
    }
}

// ---------- Konta (dane) ----------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub treasury: Pubkey,
    pub fee: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Event {
    pub organizer: Pubkey,
    pub event_id: u64,
    pub start: i64,
    pub end: i64,
    pub reward: u64,
    pub fee: u64,
    pub max_paid: u32,
    pub paid_count: u32,
    pub min_seen_secs: u32, // warunek sprawdzany przez oracle (kamera), zapisany jawnie on-chain
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub event_end: i64,
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
pub struct PayAttendee<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle, has_one = treasury)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub event: Account<'info, Event>,
    #[account(
        init,
        payer = oracle,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [b"paid", event.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    /// CHECK: tylko odbiorca SOL, dowolny portfel
    #[account(mut)]
    pub attendee: UncheckedAccount<'info>,
    /// CHECK: sprawdzany przez has_one na config
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawRemaining<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer, close = organizer)]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, Config>,
    #[account(mut, close = oracle)]
    pub receipt: Account<'info, Receipt>,
}

// ---------- Eventy i błędy ----------

#[event]
pub struct AttendeePaid {
    pub event: Pubkey,
    pub attendee: Pubkey,
    pub reward: u64,
}

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
}
