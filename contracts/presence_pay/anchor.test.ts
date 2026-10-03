// Test dla Solana Playground (beta.solpg.io): wklej do tests/anchor.test.ts i kliknij "Test".
// Twój portfel z Playground gra tu jednocześnie admina, organizatora i oracle (wybranego per event).
// Oracle tylko zgłasza obecność (reportSighting); o wypłacie decyduje program.
// Wymaga funkcji `init-if-needed` w anchor-lang (Cargo.toml projektu), patrz README.
describe("presence_pay", () => {
  const program = pg.program;
  const me = pg.wallet.publicKey;
  const sys = web3.SystemProgram.programId;
  const conn = pg.connection;

  const pda = (seeds: Buffer[]) =>
    web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const eventPda = (id: BN) =>
    pda([Buffer.from("event"), me.toBuffer(), id.toArrayLike(Buffer, "le", 8)]);
  const sightingPda = (event: web3.PublicKey, attendee: web3.PublicKey) =>
    pda([Buffer.from("sighting"), event.toBuffer(), attendee.toBuffer()]);

  const oracleInfoPda = (oracle: web3.PublicKey) => pda([Buffer.from("oracle"), oracle.toBuffer()]);

  const configPda = pda([Buffer.from("config")]);
  const treasury = web3.Keypair.generate().publicKey;
  const attendee = web3.Keypair.generate().publicKey;

  const fee = new BN(2_000_000); // 0.002 SOL
  const reward = new BN(10_000_000); // 0.01 SOL (oszczędzamy devnetowe SOL)
  const maxPaid = 3;
  const minSeen = 3; // sekundy obecności na zegarze łańcucha
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
      oracle: me, event: ev, sighting: sightingPda(ev, who), attendee: who, treasury, systemProgram: sys,
    }) as any;
  const report = (ev = event, who = attendee) =>
    send(program.methods.reportSighting().accounts(reportAccounts(ev, who)));
  const createEvent = (id: BN, oracles: web3.PublicKey[], threshold: number, start: number, end: number,
    max = maxPaid, seen = minSeen) =>
    send(
      program.methods
        .createEvent(id, oracles, threshold, new BN(start), new BN(end), reward, max, seen)
        .accounts({ organizer: me, config: configPda, event: eventPda(id), systemProgram: sys } as any)
    );

  it("init / update config (treasury + opłata dla nowych eventów)", async () => {
    const existing = await program.account.config.fetchNullable(configPda);
    const m = existing
      ? program.methods.updateConfig(treasury, fee).accounts({ admin: me, config: configPda } as any)
      : program.methods.initConfig(treasury, fee).accounts({ admin: me, config: configPda, systemProgram: sys } as any);
    await send(m);
    await eventually(async () => {
      const cfg = await program.account.config.fetch(configPda, "confirmed");
      assert.ok(cfg.treasury.equals(treasury) && cfg.fee.eq(fee));
    });
  });

  it("organizator tworzy event (1 oracle, próg 1) i wpłaca budżet", async () => {
    await createEvent(eventId, [me], 1, now - 60, now + 600);
    const rent = await conn.getMinimumBalanceForRentExemption(program.account.event.size);
    const budget = (reward.toNumber() + fee.toNumber()) * maxPaid;
    await eventually(async () => {
      const ev = await program.account.event.fetch(event, "confirmed");
      assert.equal(ev.maxPaid, maxPaid);
      assert.equal(ev.oracleCount, 1);
      assert.equal(ev.threshold, 1);
      assert.ok(ev.oracles[0].equals(me) && ev.treasury.equals(treasury));
      assert.equal(await conn.getBalance(event, "confirmed"), rent + budget);
    });
  });

  it("zły próg / zduplikowane oracle są odrzucane", async () => {
    await expectFail(createEvent(new BN(now + 3), [me], 2, now - 60, now + 600), "BadThreshold");
    await expectFail(createEvent(new BN(now + 4), [me, me], 1, now - 60, now + 600), "BadOracles");
  });

  it("pierwsze zgłoszenie nie wypłaca; po min_seen_secs program wypłaca", async () => {
    await report();
    await eventually(async () => {
      const s = await program.account.sighting.fetch(sightingPda(event, attendee), "confirmed");
      assert.equal(s.paid, false);
      assert.equal(await conn.getBalance(attendee, "confirmed"), 0);
    });
    // Zegar łańcucha bywa opóźniony: zgłaszamy co 2 s, aż program uzna, że minęło min_seen_secs.
    await eventually(async () => {
      await report();
      const s = await program.account.sighting.fetch(sightingPda(event, attendee), "confirmed");
      assert.equal(s.paid, true);
    }, 60000);
    await eventually(async () => {
      assert.equal(await conn.getBalance(attendee, "confirmed"), reward.toNumber());
      assert.equal(await conn.getBalance(treasury, "confirmed"), fee.toNumber());
      const ev = await program.account.event.fetch(event, "confirmed");
      assert.equal(ev.paidCount, 1);
    });
  });

  it("kolejne zgłoszenie po wypłacie nic nie zmienia", async () => {
    await report();
    await sleep(2000);
    assert.equal(await conn.getBalance(attendee, "confirmed"), reward.toNumber());
    const ev = await program.account.event.fetch(event, "confirmed");
    assert.equal(ev.paidCount, 1);
  });

  it("inny treasury niż zapisany w evencie jest odrzucany", async () => {
    const other = web3.Keypair.generate().publicKey;
    await expectFail(
      send(program.methods.reportSighting().accounts({ ...reportAccounts(event, other), treasury: other })),
      "ConstraintHasOne"
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
    const who = web3.Keypair.generate().publicKey;
    await report(ev5, who);
    await sleep(2000);
    await report(ev5, who);
    await eventually(async () => {
      const s = await program.account.sighting.fetch(sightingPda(ev5, who), "confirmed");
      assert.equal(s.paid, false);
      assert.equal(s.reporters, 1);
      assert.equal(await conn.getBalance(who, "confirmed"), 0);
    });
  });

  it("organizator nie może wypłacić reszty w trakcie eventu", async () => {
    await expectFail(
      send(program.methods.withdrawRemaining().accounts({ organizer: me, event } as any)),
      "EventRunning"
    );
  });

  it("sighting można zamknąć dopiero po końcu eventu", async () => {
    await expectFail(
      send(program.methods.closeSighting().accounts({ payer: me, sighting: sightingPda(event, attendee) } as any)),
      "EventRunning"
    );
  });

  it("rejestr oracli: rejestracja / zmiana / walidacja / zamknięcie", async () => {
    const info = oracleInfoPda(me);
    const accs = { oracle: me, oracleInfo: info } as any;
    // Po przerwanym poprzednim uruchomieniu wpis może już istnieć: wtedy go aktualizujemy.
    const existing = await program.account.oracleInfo.fetchNullable(info);
    await send(
      existing
        ? program.methods.updateOracle("Playground", "https://example.com").accounts(accs)
        : program.methods
            .registerOracle("Playground", "https://example.com")
            .accounts({ ...accs, systemProgram: sys } as any)
    );
    await send(program.methods.updateOracle("Playground 2", "http://example.org:8000").accounts(accs));
    await eventually(async () => {
      const o = await program.account.oracleInfo.fetch(info, "confirmed");
      assert.ok(o.oracle.equals(me));
      assert.equal(o.name, "Playground 2");
      assert.equal(o.url, "http://example.org:8000");
    });
    await expectFail(send(program.methods.updateOracle("Playground", "ftp://example.com").accounts(accs)), "BadUrl");
    await expectFail(send(program.methods.updateOracle("", "https://example.com").accounts(accs)), "BadName");
    await send(program.methods.closeOracle().accounts(accs));
    await eventually(async () => assert.equal(await program.account.oracleInfo.fetchNullable(info, "confirmed"), null));
  });

  it("anulowanie eventu przed startem zwraca cały budżet", async () => {
    const id2 = new BN(now + 1);
    const ev2 = eventPda(id2);
    await createEvent(id2, [me], 1, now + 3600, now + 7200, 1);
    await send(program.methods.withdrawRemaining().accounts({ organizer: me, event: ev2 } as any));
    await eventually(async () => assert.equal(await conn.getBalance(ev2, "confirmed"), 0));
  });
});
