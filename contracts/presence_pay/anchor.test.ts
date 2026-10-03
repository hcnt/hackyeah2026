// Test dla Solana Playground (beta.solpg.io): wklej do tests/anchor.test.ts i kliknij "Test".
// Twój portfel z Playground gra tu jednocześnie admina, organizatora i oracle (wybranego per event).
describe("presence_pay", () => {
  const program = pg.program;
  const me = pg.wallet.publicKey;
  const sys = web3.SystemProgram.programId;
  const conn = pg.connection;

  const pda = (seeds: Buffer[]) =>
    web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const eventPda = (id: BN) =>
    pda([Buffer.from("event"), me.toBuffer(), id.toArrayLike(Buffer, "le", 8)]);

  const configPda = pda([Buffer.from("config")]);
  const treasury = web3.Keypair.generate().publicKey;
  const attendee = web3.Keypair.generate().publicKey;

  const fee = new BN(2_000_000); // 0.002 SOL
  const reward = new BN(10_000_000); // 0.01 SOL (oszczędzamy devnetowe SOL)
  const maxPaid = 3;
  const now = Math.floor(Date.now() / 1000);

  const eventId = new BN(now); // unikalne przy każdym uruchomieniu
  const event = eventPda(eventId);
  const receipt = pda([Buffer.from("paid"), event.toBuffer(), attendee.toBuffer()]);

  // Wysyłka z czekaniem na "confirmed" + ponawianie sprawdzeń (publiczny devnet bywa opóźniony).
  const send = (m: any) => m.rpc({ commitment: "confirmed" });
  const eventually = async (check: () => Promise<void>, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        return await check();
      } catch (e) {
        if (Date.now() - t0 > ms) throw e;
        await new Promise((r) => setTimeout(r, 1000));
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

  const payAccounts = {
    oracle: me, event, receipt, attendee, treasury, systemProgram: sys,
  } as any;

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

  it("organizator tworzy event i wpłaca budżet", async () => {
    await send(
      program.methods
        .createEvent(eventId, me, new BN(now - 60), new BN(now + 600), reward, maxPaid, 3)
        .accounts({ organizer: me, config: configPda, event, systemProgram: sys } as any)
    );
    const rent = await conn.getMinimumBalanceForRentExemption(program.account.event.size);
    const budget = (reward.toNumber() + fee.toNumber()) * maxPaid;
    await eventually(async () => {
      const ev = await program.account.event.fetch(event, "confirmed");
      assert.equal(ev.maxPaid, maxPaid);
      assert.ok(ev.oracle.equals(me) && ev.treasury.equals(treasury));
      assert.equal(await conn.getBalance(event, "confirmed"), rent + budget);
    });
  });

  it("oracle wypłaca nagrodę uczestnikowi", async () => {
    await send(program.methods.payAttendee().accounts(payAccounts));
    await eventually(async () => {
      assert.equal(await conn.getBalance(attendee, "confirmed"), reward.toNumber());
      assert.equal(await conn.getBalance(treasury, "confirmed"), fee.toNumber());
      const ev = await program.account.event.fetch(event, "confirmed");
      assert.equal(ev.paidCount, 1);
    });
  });

  it("druga wypłata dla tego samego portfela się nie udaje", async () => {
    await expectFail(send(program.methods.payAttendee().accounts(payAccounts)), "already in use");
  });

  it("inny treasury niż zapisany w evencie jest odrzucany", async () => {
    const other = web3.Keypair.generate().publicKey;
    const r2 = pda([Buffer.from("paid"), event.toBuffer(), other.toBuffer()]);
    await expectFail(
      send(program.methods.payAttendee().accounts({ ...payAccounts, receipt: r2, attendee: other, treasury: other })),
      "ConstraintHasOne"
    );
  });

  it("oracle innego eventu nie może wypłacać", async () => {
    const id3 = new BN(now + 2);
    const ev3 = eventPda(id3);
    const otherOracle = web3.Keypair.generate().publicKey; // organizator wybrał inny oracle
    await send(
      program.methods
        .createEvent(id3, otherOracle, new BN(now - 60), new BN(now + 600), reward, 1, 3)
        .accounts({ organizer: me, config: configPda, event: ev3, systemProgram: sys } as any)
    );
    const r3 = pda([Buffer.from("paid"), ev3.toBuffer(), attendee.toBuffer()]);
    await expectFail(
      send(program.methods.payAttendee().accounts({ ...payAccounts, event: ev3, receipt: r3 })),
      "ConstraintHasOne"
    );
    // Sprzątanie: event jeszcze trwa, więc budżetu nie da się teraz wypłacić (EventRunning); zostaje na devnecie.
  });

  it("organizator nie może wypłacić reszty w trakcie eventu", async () => {
    await expectFail(
      send(program.methods.withdrawRemaining().accounts({ organizer: me, event } as any)),
      "EventRunning"
    );
  });

  it("anulowanie eventu przed startem zwraca cały budżet", async () => {
    const id2 = new BN(now + 1);
    const ev2 = eventPda(id2);
    await send(
      program.methods
        .createEvent(id2, me, new BN(now + 3600), new BN(now + 7200), reward, 1, 3)
        .accounts({ organizer: me, config: configPda, event: ev2, systemProgram: sys } as any)
    );
    await send(program.methods.withdrawRemaining().accounts({ organizer: me, event: ev2 } as any));
    await eventually(async () => assert.equal(await conn.getBalance(ev2, "confirmed"), 0));
  });
});
