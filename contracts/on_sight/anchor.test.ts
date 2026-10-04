// Test dla Solana Playground (beta.solpg.io): wklej do tests/anchor.test.ts i kliknij "Test".
// Twój portfel z Playground gra tu jednocześnie organizatora i oracle (wybranego per event).
// Opłata (FEE_LAMPORTS) trafia do oracla, którego zgłoszenie wypłaciło, czyli też do tego portfela.
// Oracle tylko zgłasza obecność (reportSighting); o wypłacie decyduje program.
// Każde zgłoszenie poprzedza weryfikacja ed25519 podpisu uczestnika pod wiadomością dołączenia (joinProof).
// Wymaga funkcji `init-if-needed` w anchor-lang (Cargo.toml projektu), patrz README.
describe("on_sight", () => {
  const program = pg.program;
  const me = pg.wallet.publicKey;
  const sys = web3.SystemProgram.programId;
  const conn = pg.connection;

  const pda = (seeds: Buffer[]) =>
    web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const eventPda = (id: BN) =>
    pda([Buffer.from("event"), me.toBuffer(), id.toArrayLike(Buffer, "le", 8)]);
  const attendancePda = (event: web3.PublicKey, attendee: web3.PublicKey) =>
    pda([Buffer.from("attendance"), event.toBuffer(), attendee.toBuffer()]);

  const oracleInfoPda = (oracle: web3.PublicKey) => pda([Buffer.from("oracle"), oracle.toBuffer()]);

  const attendeeKp = web3.Keypair.generate(); // uczestnik podpisuje dołączenie, więc potrzebny jest jego klucz
  const attendee = attendeeKp.publicKey;

  const fee = new BN(2_000_000); // FEE_LAMPORTS z lib.rs (0.002 SOL), zamrażana w Event.fee
  const txFee = 10_000; // opłata devnetu za zgłoszenie: podpis oracla + podpis ed25519 uczestnika, po 5000
  const reward = new BN(10_000_000); // 0.01 SOL (oszczędzamy devnetowe SOL)
  const maxPaid = 3;
  const minSeen = 3; // sekundy obecności na zegarze łańcucha
  const eventName = "HackYeah 2026 🎉"; // 1..=64 bajtów UTF-8 (emoji = 4 bajty)
  const eventVenue = "Tauron Arena, Kraków"; // 0..=64 bajtów, pusty = brak
  const now = Math.floor(Date.now() / 1000);

  const eventId = new BN(now); // unikalne przy każdym uruchomieniu
  const event = eventPda(eventId);

  // Wysyłka z czekaniem na "confirmed" + ponawianie sprawdzeń (publiczny devnet bywa opóźniony).
  const send = (m: any) => m.rpc({ commitment: "confirmed" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const eventually = async (check: () => Promise<void>, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        return await check();
      } catch (e) {
        if (Date.now() - t0 > ms) throw e;
        await sleep(1000);
      }
    }
  };

  const expectFail = async (p: Promise<any>, code: string) => {
    try {
      await p;
    } catch (e) {
      const text = String(e) + JSON.stringify((e as any).logs ?? []);
      assert.ok(text.includes(code), `expected ${code}, got ${text}`);
      return;
    }
    assert.fail(`expected ${code}, but tx succeeded`);
  };

  const reportAccounts = (ev: web3.PublicKey, who: web3.PublicKey) =>
    ({
      oracle: me, event: ev, attendance: attendancePda(ev, who), attendee: who, systemProgram: sys,
      instructions: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    }) as any;
  // Podpis dołączenia, jak w widgecie (wallet signMessage), sprawdzany natywnym programem Ed25519 w tej samej transakcji.
  const joinProof = (ev: web3.PublicKey, who: web3.Keypair) =>
    web3.Ed25519Program.createInstructionWithPrivateKey({
      privateKey: who.secretKey,
      message: Buffer.from(
        `Attend Now\nAction: join\nEvent: ${ev.toBase58()}\nWallet: ${who.publicKey.toBase58()}\n` +
          `Consent: 2026-10-03\nTime: ${new Date().toISOString()}`
      ),
    });
  const report = (ev = event, who = attendeeKp) =>
    send(
      program.methods
        .reportSighting()
        .accounts(reportAccounts(ev, who.publicKey))
        .preInstructions([joinProof(ev, who)])
    );
  const createEvent = (id: BN, oracles: web3.PublicKey[], threshold: number, start: number, end: number,
    max = maxPaid, seen = minSeen, name = eventName, venue = eventVenue) =>
    send(
      program.methods
        .createEvent(id, oracles, threshold, new BN(start), new BN(end), reward, max, seen, name, venue)
        .accounts({ organizer: me, event: eventPda(id), systemProgram: sys } as any)
    );

  it("organizator tworzy event (1 oracle, próg 1) i wpłaca budżet", async () => {
    await createEvent(eventId, [me], 1, now - 60, now + 600);
    const rent = await conn.getMinimumBalanceForRentExemption(program.account.event.size);
    const budget = (reward.toNumber() + fee.toNumber()) * maxPaid;
    await eventually(async () => {
      const ev = await program.account.event.fetch(event, "confirmed");
      assert.equal(ev.maxPaid, maxPaid);
      assert.equal(ev.oracleCount, 1);
      assert.equal(ev.threshold, 1);
      assert.ok(ev.oracles[0].equals(me));
      assert.ok(ev.fee.eq(fee));
      assert.equal(ev.name, eventName);
      assert.equal(ev.venue, eventVenue);
      assert.equal(await conn.getBalance(event, "confirmed"), rent + budget);
    });
  });

  it("nazwa i miejsce: pusty venue jest OK, zła nazwa / za długi venue / znak sterujący = BadEventText", async () => {
    const id6 = new BN(now + 6);
    const name64 = "ą".repeat(32); // dokładnie 64 bajty (32 znaki po 2 bajty)
    await createEvent(id6, [me], 1, now + 3600, now + 7200, 1, 0, name64, "");
    await eventually(async () => {
      const ev = await program.account.event.fetch(eventPda(id6), "confirmed");
      assert.equal(ev.name, name64);
      assert.equal(ev.venue, "");
    });
    // Sprzątanie: event jeszcze się nie zaczął, więc anulowanie zwraca budżet.
    await send(program.methods.withdrawRemaining().accounts({ organizer: me, event: eventPda(id6) } as any));

    const bad: [string, string][] = [
      ["", eventVenue], // pusta nazwa
      ["n".repeat(65), ""], // 65 bajtów
      [eventName, "v".repeat(65)], // venue 65 bajtów
      ["Hack\nYeah", ""], // znak sterujący
    ];
    for (const [i, [name, venue]] of bad.entries()) {
      const id = new BN(now + 10 + i);
      await expectFail(createEvent(id, [me], 1, now - 60, now + 600, 1, 0, name, venue), "BadEventText");
      assert.equal(await conn.getAccountInfo(eventPda(id), "confirmed"), null); // nic nie powstało
    }
  });

  it("zły próg / zduplikowane oracle są odrzucane", async () => {
    await expectFail(createEvent(new BN(now + 3), [me], 2, now - 60, now + 600), "BadThreshold");
    await expectFail(createEvent(new BN(now + 4), [me, me], 1, now - 60, now + 600), "BadOracles");
  });

  it("pierwsze zgłoszenie nie wypłaca; po min_seen_secs program wypłaca (opłata dla oracla)", async () => {
    await report();
    let before = 0; // saldo oracla (me) po pierwszym zgłoszeniu, które zapłaciło też depozyt Attendance
    await eventually(async () => {
      const s = await program.account.attendance.fetch(attendancePda(event, attendee), "confirmed");
      assert.equal(s.paid, false);
      assert.equal(await conn.getBalance(attendee, "confirmed"), 0);
      before = await conn.getBalance(me, "confirmed");
    });
    // Zegar łańcucha bywa opóźniony: zgłaszamy co 2 s, aż program uzna, że minęło min_seen_secs.
    let reports = 0;
    await eventually(async () => {
      await report();
      reports += 1;
      const s = await program.account.attendance.fetch(attendancePda(event, attendee), "confirmed");
      assert.equal(s.paid, true);
    }, 60000);
    await eventually(async () => {
      assert.equal(await conn.getBalance(attendee, "confirmed"), reward.toNumber());
      const ev = await program.account.event.fetch(event, "confirmed");
      assert.equal(ev.paidCount, 1);
      // Oracle dostał opłatę i zapłacił za każde zgłoszenie; tolerancja na opóźnione odczyty salda z RPC.
      const gained = (await conn.getBalance(me, "confirmed")) - before;
      const expected = fee.toNumber() - reports * txFee;
      assert.ok(Math.abs(gained - expected) <= 2 * txFee, `oracle gained ${gained}, expected ~${expected}`);
    });
  });

  it("kolejne zgłoszenie po wypłacie nic nie zmienia", async () => {
    await report();
    await sleep(2000);
    assert.equal(await conn.getBalance(attendee, "confirmed"), reward.toNumber());
    const ev = await program.account.event.fetch(event, "confirmed");
    assert.equal(ev.paidCount, 1);
  });

  it("zgłoszenie bez podpisu dołączenia uczestnika jest odrzucane", async () => {
    const stranger = web3.Keypair.generate();
    // bez weryfikacji ed25519
    await expectFail(
      send(program.methods.reportSighting().accounts(reportAccounts(event, stranger.publicKey))),
      "BadJoinProof"
    );
    // podpis dołączenia do INNEGO eventu
    await expectFail(
      send(
        program.methods
          .reportSighting()
          .accounts(reportAccounts(event, stranger.publicKey))
          .preInstructions([joinProof(eventPda(new BN(now + 99)), stranger)])
      ),
      "BadJoinProof"
    );
  });

  it("klucz spoza listy oracli eventu nie może zgłaszać", async () => {
    const id3 = new BN(now + 2);
    const otherOracle = web3.Keypair.generate().publicKey; // organizator wybrał inny oracle
    await createEvent(id3, [otherOracle], 1, now - 60, now + 600, 1, 0);
    await expectFail(report(eventPda(id3)), "NotOracle");
    // Sprzątanie: event jeszcze trwa, więc budżetu nie da się teraz wypłacić (EventRunning); zostaje na devnecie.
  });

  it("próg 2 z 2: zgłoszenia jednego oracla nigdy nie wypłacają", async () => {
    const id5 = new BN(now + 5);
    const ev5 = eventPda(id5);
    const otherOracle = web3.Keypair.generate().publicKey;
    await createEvent(id5, [me, otherOracle], 2, now - 60, now + 600, 1, 0);
    const who = web3.Keypair.generate();
    await report(ev5, who);
    await sleep(2000);
    await report(ev5, who);
    await eventually(async () => {
      const s = await program.account.attendance.fetch(attendancePda(ev5, who.publicKey), "confirmed");
      assert.equal(s.paid, false);
      assert.equal(s.reporters, 1);
      assert.equal(await conn.getBalance(who.publicKey, "confirmed"), 0);
    });
  });

  it("organizator nie może wypłacić reszty w trakcie eventu", async () => {
    await expectFail(
      send(program.methods.withdrawRemaining().accounts({ organizer: me, event } as any)),
      "EventRunning"
    );
  });

  it("attendance można zamknąć dopiero po końcu eventu", async () => {
    await expectFail(
      send(program.methods.closeAttendance().accounts({ payer: me, attendance: attendancePda(event, attendee) } as any)),
      "EventRunning"
    );
  });

  it("rejestr oracli: rejestracja / ponowna rejestracja zmienia wpis / walidacja", async () => {
    const info = oracleInfoPda(me);
    const accs = { oracle: me, oracleInfo: info, systemProgram: sys } as any;
    const register = (name: string, url: string) => send(program.methods.registerOracle(name, url).accounts(accs));
    // Pierwsze wywołanie tworzy wpis (albo zmienia go, jeśli został po poprzednim uruchomieniu).
    await register("Playground", "https://example.com");
    await eventually(async () => {
      const o = await program.account.oracleInfo.fetch(info, "confirmed");
      assert.ok(o.oracle.equals(me));
      assert.equal(o.name, "Playground");
      assert.equal(o.url, "https://example.com");
    });
    // Drugie wywołanie (init_if_needed) nie tworzy nowego konta, tylko zmienia nazwę i url.
    await register("Playground 2", "http://example.org:8000");
    await eventually(async () => {
      const o = await program.account.oracleInfo.fetch(info, "confirmed");
      assert.ok(o.oracle.equals(me));
      assert.equal(o.name, "Playground 2");
      assert.equal(o.url, "http://example.org:8000");
    });
    await expectFail(register("Playground", "ftp://example.com"), "BadUrl");
    await expectFail(register("", "https://example.com"), "BadName");
    // Wpisu nie da się usunąć (nie ma close_oracle); zostaje na devnecie z wartościami testowymi.
  });

  it("anulowanie eventu przed startem zwraca cały budżet", async () => {
    const id2 = new BN(now + 1);
    const ev2 = eventPda(id2);
    await createEvent(id2, [me], 1, now + 3600, now + 7200, 1);
    await send(program.methods.withdrawRemaining().accounts({ organizer: me, event: ev2 } as any));
    await eventually(async () => assert.equal(await conn.getBalance(ev2, "confirmed"), 0));
  });
});
