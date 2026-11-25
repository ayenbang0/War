/**
 * The story's memory (phase K9): every flag a letter, an encounter or an
 * ending can set or read, with a line saying what it records.
 *
 * Declared in one table so a misspelt flag is an error, not a branch that
 * silently never fires: validate-story.ts checks that every flag named
 * anywhere is declared here, that every declared flag is set by something,
 * and that every declared flag is read by something (a trigger, a choice's
 * requirement, an act goal or an epilogue line) -- a flag nothing reads is a
 * choice that changes nothing, which the player would rightly resent.
 *
 * Plain data. K9 keeps the set flags in the kingdom save, as a sorted list of
 * these ids, so the hash and the save are independent of insertion order.
 */

export const STORY_FLAGS: Readonly<Record<string, string>> = {
  // Act I
  "kept-isolde-letters": "Brother Aldous kept copies of the Regent's letters: a hand to compare against",
  "banner-raised": "a banner flew over Rookstead the first winter, and the Hare saw it",
  "quiet-winter": "Rookstead lay quiet the first winter, flying nothing",
  "customs-sworn": "the king swore at the Thornwick stone to keep the Reach's customs",
  // Act II
  "margrave-terms-accepted": "the king took the Margrave's purse and swore not to cross the Lisle",
  "road-ferry": "at the fork, the king relieved Hallow Ferry",
  "road-wood": "at the fork, the king held the Long Wood",
  "ferry-relieved": "Hallow Ferry was relieved and its reeve lived",
  "mallow-dead": "Edric Mallow, reeve of Hallow Ferry, died when the town fell",
  "oath-ferry": "the king swore aloud to take Hallow Ferry back",
  "isolde-answered": "the king answered Isolde's first letter with one line",
  "isolde-scorned": "the king burned Isolde's first letter unanswered",
  "fell-for-forgery": "the army marched into the Wold in the dark on a forged report",
  "forgery-spotted": "Brother Aldous read the forged report twice and caught it",
  "second-seal": "a second seal, not the king's, was found on the forger's courier",
  // Act III
  "stag-sworn": "the Stag swore to the king after the colours",
  "stag-paroled": "the Stag went home to Stagcrown on parole",
  "stag-hanged": "the Stag was hanged at High Tarn",
  "isolde-villain": "the king named Isolde traitor, and Isolde became one",
  "isolde-coward": "the king let Isolde go, and Isolde fled over the sea",
  "isolde-ally": "the king sent Isolde back to the Crown Seat as the king's eyes",
  "isolde-shielded": "the king burned Isolde's proof to keep Isolde safe",
  "vael-named": "the Chancellor's part in the coup was made public",
  "vael-secret": "the proof against the Chancellor was kept back for the gates",
  "lords-convinced": "the lords saw the Regent's hand laid beside the forger's",
  "margrave-pardoned": "the Margrave was pardoned on oath at Redcastle",
  "margrave-tried": "the Margrave was tried in open court and exiled to the Reach",
  "margrave-hanged": "the Margrave was hanged from the gate of Redcastle",
  "fields-burned": "the king burned the fields along the Lisle road to starve the crown's riders",
  "adepts-promised": "the king promised the unlicensed Adepts a licence",
  // Act IV
  "lied-to-vael": "the king pretended to accept the Chancellor's offer to buy a month",
  "gatehouse-threatened": "the king promised the gatehouse of Rimaros fire, with Isolde on it",
  "kingsmere-sacked": "the army was given Kingsmere for a day",
  "lords-rights-restored": "the lords had their old courts, tolls and levies back",
  "walls-breached": "the walls of Rimaros were breached on the river side",
};

export const STORY_FLAG_IDS: readonly string[] = Object.keys(STORY_FLAGS);
