/**
 * Exploration events (PLAN.md §A.6, §B.11a; phase K3a): what the king's
 * party finds the first time it sets foot in an exploration site -- a ruin,
 * an old shrine, a mine, a deep wood, a stretch of coast, an abandoned fort.
 *
 * Each event is a short letter from Brother Aldous with two or three
 * choices, presented on the kingdom map as an event card. Plain data keyed
 * by id (§A.6: every word in a table, so it can be audited and translated).
 * The sim (sim/kingdom/explore.ts) draws one for a site on the `events`
 * stream, from the undrawn events of the site's kind and those that fit
 * anywhere, and applies a choice when a `resolveEvent` order names it -- so
 * an exploration replays exactly from the order log.
 *
 * Choice effects:
 *   gain        stocks into the stores (ledger: finds)
 *   pay         stocks the choice COSTS: it cannot be chosen without them
 *               (ledger: offerings). Paid whether or not a gamble comes off
 *   lose        stocks taken if there are any (ledger: offerings) -- for a
 *               gamble that goes wrong, never a price
 *   legitimacy  up (ledger: deeds) or down (disgrace)
 *   upgrade     a special upgrade (upgrades.ts), kept for good
 *   reveal      every holding within `miles` of the site becomes known
 *               (remembered, not seen) -- a guide, a map, a traveller's news
 *
 * A choice may be a gamble (`chance`): with `pct` percent its own result and
 * effects, otherwise `fail`'s. The roll is on the events stream.
 *
 * Every event keeps one choice that costs nothing, so no card can trap a
 * player with an empty store (validated in story/validate.ts).
 *
 * The text never guesses anyone's gender: people are "the hermit", "the
 * keeper", "they" (a test holds every string to that).
 */

import type { Cost } from "../kingdom/buildings.ts";
import type { SiteKind } from "../kingdom/map.ts";
import type { UpgradeId } from "./upgrades.ts";

export type EventEffect =
  | { readonly kind: "gain"; readonly gains: Cost }
  | { readonly kind: "pay"; readonly cost: Cost }
  | { readonly kind: "lose"; readonly loss: Cost }
  | { readonly kind: "legitimacy"; readonly delta: number }
  | { readonly kind: "upgrade"; readonly upgrade: UpgradeId }
  | { readonly kind: "reveal"; readonly miles: number };

export type EventOutcome = {
  /** What happened, for the card and the feed. */
  readonly result: string;
  readonly effects: readonly EventEffect[];
};

export type EventChoice = EventOutcome & {
  /** The button. A verb first, short. */
  readonly label: string;
  /** A gamble: `pct` percent this choice's own outcome, otherwise `fail`. */
  readonly chance?: { readonly pct: number; readonly fail: EventOutcome };
};

export type StoryEventDef = {
  readonly id: string;
  /** The kind of site it can be found at; "any" fits every site. */
  readonly site: SiteKind | "any";
  readonly title: string;
  /** The letter: two or three sentences. */
  readonly text: string;
  /** Two or three. */
  readonly choices: readonly EventChoice[];
};

export const STORY_EVENTS: readonly StoryEventDef[] = [
  // -- abandoned forts -----------------------------------------------------------
  {
    id: "lamp-room", site: "fort", title: "The Lamp Room",
    text: "The tower's stair is rotten, but the lamp room at the top is whole: a great lantern, its lenses wrapped in oiled cloth, and the lamp-keeper's book of signals. Someone meant to come back for them.",
    choices: [
      { label: "Take the lenses and the book", result: "The lenses travel wrapped in your spare cloak. Any tower you raise will see further for them.", effects: [{ kind: "upgrade", upgrade: "lantern-of-the-watch" }] },
      { label: "Strip the tower for timber", result: "The floors come down in a morning. Ten loads of seasoned oak for the carts.", effects: [{ kind: "gain", gains: { timber: 10 } }] },
    ],
  },
  {
    id: "sealed-armoury", site: "fort", title: "The Sealed Armoury",
    text: "Behind the guardroom a doorway has been bricked up, and recently: the mortar is still pale. The garrison that left took care that nobody else would have what lies behind it.",
    choices: [
      {
        label: "Break the wall", result: "Racks of blades and mail, greased and sound. The old garrison kept its arms better than its fort.",
        effects: [{ kind: "upgrade", upgrade: "forgotten-armoury" }],
        chance: { pct: 70, fail: { result: "Rust and rot. Three bars' worth of iron is all that can be saved.", effects: [{ kind: "gain", gains: { iron: 3 } }] } },
      },
      { label: "Leave it sealed", result: "You leave the soldiers' work as they left it. Word of it travels, as such things do.", effects: [{ kind: "legitimacy", delta: 1 }] },
    ],
  },
  {
    id: "old-guard-banner", site: "fort", title: "The Old Guard's Banner",
    text: "In the fort's chapel hangs the banner of the royal guard, faded to the colour of straw. An old soldier keeps it, and stands when you come in, as if no years had passed at all.",
    choices: [
      { label: "Take up the banner", result: "The keeper gives it into your hands without a word. It will fly over the next army you lead.", effects: [{ kind: "upgrade", upgrade: "banner-of-the-old-guard" }, { kind: "legitimacy", delta: 1 }] },
      { label: "Ask the keeper to ride with you", result: "The banner stays on its wall. The keeper comes, and brings a grandchild who can carry a pack.", effects: [{ kind: "gain", gains: { levy: 2 } }] },
    ],
  },
  {
    id: "veterans-at-the-gate", site: "fort", title: "Veterans at the Gate",
    text: "A handful of old soldiers have made the gatehouse their home. They fought for the crown once, and were paid off with nothing when the Margrave came. They watch you the way old soldiers watch anyone.",
    choices: [
      { label: "Swear them to you (6 grain)", result: "They swear the old oath over a shared meal. Others who served will hear of it at every muster.", effects: [{ kind: "pay", cost: { grain: 6 } }, { kind: "upgrade", upgrade: "veterans-oath" }, { kind: "gain", gains: { levy: 2 } }] },
      { label: "Share your bread and go on", result: "You eat together and part friends. They will say good things of the exile in the alehouses.", effects: [{ kind: "pay", cost: { grain: 4 } }, { kind: "legitimacy", delta: 2 }] },
      { label: "Turn them out and take the stores", result: "The stores are yours. The look on their faces as they go will be remembered longer than the grain.", effects: [{ kind: "gain", gains: { grain: 15 } }, { kind: "legitimacy", delta: -2 }] },
    ],
  },
  {
    id: "seal-in-the-strongroom", site: "fort", title: "The Seal in the Strongroom",
    text: "The strongroom door hangs open and the coffers are long gone, but in a niche the looters missed lies a seal matrix of the old crown, the kind a royal reeve carried to stamp writs of tax.",
    choices: [
      { label: "Keep the seal", result: "Writs under the old seal will be paid with less grumbling than the usurper's.", effects: [{ kind: "upgrade", upgrade: "old-kings-seal" }] },
      { label: "Melt it down", result: "The silver fetches twenty pennies. Brother Aldous writes nothing of it, which says enough.", effects: [{ kind: "gain", gains: { coin: 20 } }, { kind: "legitimacy", delta: -2 }] },
    ],
  },
  {
    id: "smugglers-cache", site: "fort", title: "The Smugglers' Cache",
    text: "The cellars are full: casks, sacks and a strongbox, none of it the old garrison's. Whoever uses the fort now uses it for trade the tax-gatherers never see.",
    choices: [
      { label: "Seize the cache", result: "Eight pennies and twenty days of bread, and somewhere, a smuggler who will not forget you.", effects: [{ kind: "gain", gains: { coin: 8, grain: 20 } }] },
      {
        label: "Wait for them and bargain", result: "They come at dusk, wary, and leave with an understanding. Two of them stay.",
        effects: [{ kind: "gain", gains: { levy: 2, coin: 4 } }],
        chance: { pct: 50, fail: { result: "Nobody comes. The cellars stay full and the party is a day older.", effects: [] } },
      },
      { label: "Leave word and leave it", result: "You leave a note that the king's peace is coming back. A strange thing to leave smugglers, but it is talked of.", effects: [{ kind: "legitimacy", delta: 1 }] },
    ],
  },

  // -- ruins ---------------------------------------------------------------------
  {
    id: "tumbled-mill", site: "ruin", title: "The Tumbled Mill",
    text: "The mill is a heap and its leat is dry, but the millstones lie where they fell, French burr, worth more than the building ever was. They would grind twice the corn of any country stone.",
    choices: [
      { label: "Cart the stones away (6 grain)", result: "It takes a day and a hired ox. Any mill of yours will grind the finer for them.", effects: [{ kind: "pay", cost: { grain: 6 } }, { kind: "upgrade", upgrade: "old-mill-stones" }] },
      { label: "Take the beams for timber", result: "The beams are sound. Eight loads for the carts.", effects: [{ kind: "gain", gains: { timber: 8 } }] },
    ],
  },
  {
    id: "barrow-door", site: "ruin", title: "The Barrow's Door",
    text: "The door stone of the barrow has been shifted a hand's width, and a cold breath comes out of the dark. The country folk will not come within a field of it.",
    choices: [
      {
        label: "Go in", result: "Grave goods older than the kingdom: coin of a forgotten king, and good bronze. The dead do not complain.",
        effects: [{ kind: "gain", gains: { coin: 15, iron: 2 } }],
        chance: { pct: 60, fail: { result: "The roof gives as you enter. Everyone is dug out alive, but one follower has had enough of exile and goes home.", effects: [{ kind: "lose", loss: { levy: 1 } }] } },
      },
      { label: "Close it and say a prayer", result: "You set the stone back. The country folk see it done, and nod.", effects: [{ kind: "legitimacy", delta: 1 }] },
    ],
  },
  {
    id: "surveyors-chest", site: "ruin", title: "The Surveyors' Chest",
    text: "In what was a hall, a lead-lined chest has kept the rain off the old crown surveyors' rolls: roads, fords and steadings, drawn by people who walked every mile of them.",
    choices: [
      { label: "Keep the maps", result: "With the rolls to read the land by, the party sees the lie of the country further ahead.", effects: [{ kind: "upgrade", upgrade: "wayfinders-map" }, { kind: "reveal", miles: 120 }] },
      { label: "Sell them to a carter", result: "Six pennies, and the carter goes away delighted.", effects: [{ kind: "gain", gains: { coin: 6 } }] },
    ],
  },
  {
    id: "moot-stone", site: "ruin", title: "The Moot Stone",
    text: "A ring of tumbled walls round a standing stone: the old moot, where the country brought its quarrels to the king's justice. A few people are here, as if they half expected someone.",
    choices: [
      { label: "Hold a moot (10 grain)", result: "You sit until dark hearing boundary disputes and a stolen pig. Two young people ask to follow the one who listened.", effects: [{ kind: "pay", cost: { grain: 10 } }, { kind: "legitimacy", delta: 3 }, { kind: "gain", gains: { levy: 2 } }] },
      { label: "Pass by", result: "The stone keeps its counsel, and so do the people.", effects: [] },
    ],
  },
  {
    id: "broken-chantry", site: "ruin", title: "The Broken Chantry",
    text: "A chantry where priests once sang for the souls of the kings of Rimaros: your own grandparents among them. The roof lead is still on, which is the only thing still on.",
    choices: [
      { label: "Strip the lead", result: "Ten pennies of lead. The rain comes in where the kings were prayed for.", effects: [{ kind: "gain", gains: { coin: 10 } }, { kind: "legitimacy", delta: -1 }] },
      { label: "Say the office for the kings", result: "Brother Aldous sings it, a little flat. It is the first time in years anyone has.", effects: [{ kind: "legitimacy", delta: 2 }] },
    ],
  },

  // -- shrines -------------------------------------------------------------------
  {
    id: "the-hermit", site: "shrine", title: "The Hermit",
    text: "A hermit keeps a garden of herbs behind the shrine and seems unsurprised to see a king. The hermit knows every plant on the hill and every path off it.",
    choices: [
      { label: "Ask for the hermit's craft", result: "A day of patient teaching. Your herb fields will grow stronger, and your healers will know what to do with them.", effects: [{ kind: "upgrade", upgrade: "hermits-herbs" }] },
      { label: "Ask for a blessing", result: "The blessing is short and plain. People will hear that the hermit gave it.", effects: [{ kind: "legitimacy", delta: 2 }] },
      { label: "Ask the way", result: "The hermit draws the country in the dirt with a stick, every steading for days around.", effects: [{ kind: "reveal", miles: 130 }] },
    ],
  },
  {
    id: "pilgrims", site: "shrine", title: "Pilgrims on the Old Road",
    text: "Pilgrims rest at the shrine, on their way along the old road of shrines the kings once kept. The road is half forgotten, they say, since nobody pays its keepers now.",
    choices: [
      { label: "Pay the keepers (8 grain)", result: "The keepers will tend the road again, and every shrine you raise will be a stop on it.", effects: [{ kind: "pay", cost: { grain: 8 } }, { kind: "upgrade", upgrade: "pilgrim-road" }] },
      { label: "Ask them to carry your name", result: "They will tell the shrines down the road that the king is alive and walking.", effects: [{ kind: "legitimacy", delta: 2 }] },
    ],
  },
  {
    id: "holy-well", site: "shrine", title: "The Holy Well",
    text: "The well is said to heal, and the rags tied to the thorn tree over it say people believe so. The water is very cold and tastes of iron.",
    choices: [
      { label: "Leave an offering (5 grain)", result: "You leave bread on the stone, as the country does. It is seen.", effects: [{ kind: "pay", cost: { grain: 5 } }, { kind: "legitimacy", delta: 3 }] },
      { label: "Bottle the water to sell", result: "Five pennies from a credulous innkeeper, and a sour look from Brother Aldous.", effects: [{ kind: "gain", gains: { coin: 5 } }, { kind: "legitimacy", delta: -1 }] },
    ],
  },
  {
    id: "oath-stone", site: "shrine", title: "The Oath Stone",
    text: "Kings of Rimaros swore their crowning oath on this stone before they ever saw the capital. Yours was sworn here too, a long time ago, in better clothes.",
    choices: [
      { label: "Swear again before witnesses (6 grain)", result: "The oath is short. The feast after it is shorter. Those who saw it will tell it for years.", effects: [{ kind: "pay", cost: { grain: 6 } }, { kind: "legitimacy", delta: 4 }] },
      { label: "Touch the stone and go on", result: "The stone is warm from the sun. Nobody else is there to see.", effects: [] },
    ],
  },
  {
    id: "sanctuary", site: "shrine", title: "Sanctuary",
    text: "A dozen people have claimed sanctuary at the shrine: tenants who ran from the captains' new taxes. The keeper feeds them as long as the keeper can.",
    choices: [
      { label: "Offer them your banner", result: "Three of the younger ones come. The rest have children, and stay.", effects: [{ kind: "gain", gains: { levy: 3 } }] },
      { label: "Leave them bread (8 grain)", result: "You leave what you can spare. Charity costs; this kind is remembered.", effects: [{ kind: "pay", cost: { grain: 8 } }, { kind: "legitimacy", delta: 2 }] },
    ],
  },

  // -- mines ---------------------------------------------------------------------
  {
    id: "old-workings", site: "mine", title: "The Old Workings",
    text: "The upper galleries are worked out, dry and cool, and the old miners' props still hold. A store kept down here would keep a long time.",
    choices: [
      { label: "Shore them up as a store (6 timber)", result: "A day of carpentry. The galleries will keep grain as well as any granary.", effects: [{ kind: "pay", cost: { timber: 6 } }, { kind: "upgrade", upgrade: "deep-cellars" }] },
      { label: "Pick over the spoil heaps", result: "Three bars' worth of ore the old miners threw away.", effects: [{ kind: "gain", gains: { iron: 3 } }] },
    ],
  },
  {
    id: "bright-vein", site: "mine", title: "A Vein Still Bright",
    text: "The few miners left show you a vein the reeve never found, because nobody told the reeve. They would work it for someone who paid.",
    choices: [
      { label: "Pay them to work it (5 coin)", result: "A week's work, and eight bars of iron for your stores.", effects: [{ kind: "pay", cost: { coin: 5 } }, { kind: "gain", gains: { iron: 8 } }] },
      { label: "Take what is already dug", result: "Three bars. The miners say nothing, which miners rarely do.", effects: [{ kind: "gain", gains: { iron: 3 } }, { kind: "legitimacy", delta: -1 }] },
    ],
  },
  {
    id: "miners-grievance", site: "mine", title: "The Miners' Grievance",
    text: "The usurper's reeve took a season of their ore and never paid. They want to know what kind of king you mean to be before they say another word.",
    choices: [
      { label: "Promise them their due", result: "A promise is cheap, but they have had none at all. Two of them follow, to see it kept.", effects: [{ kind: "legitimacy", delta: 1 }, { kind: "gain", gains: { levy: 2 } }] },
      { label: "Pay something now (4 coin)", result: "Four pennies is not a season's ore, but it is more than the reeve paid. Four follow.", effects: [{ kind: "pay", cost: { coin: 4 } }, { kind: "gain", gains: { levy: 4 } }, { kind: "legitimacy", delta: 2 }] },
    ],
  },

  // -- deep woods ----------------------------------------------------------------
  {
    id: "charcoal-burners", site: "forest", title: "The Charcoal Burners",
    text: "Smoke in the clearing: charcoal burners, black to the elbows, tending their clamps. They have a way of stacking the wood that loses nothing to the fire.",
    choices: [
      { label: "Learn their pits", result: "Two of your people stay a week to learn. Your woodpiles will grow by a load a day.", effects: [{ kind: "upgrade", upgrade: "charcoal-pits" }] },
      { label: "Buy charcoal (2 coin)", result: "Eight loads of fuel, packed tight in sacks.", effects: [{ kind: "pay", cost: { coin: 2 } }, { kind: "gain", gains: { timber: 8 } }] },
    ],
  },
  {
    id: "wild-hives", site: "forest", title: "Wild Hives",
    text: "Honey-takers work the hollow oaks with smoke and long knives. They find food where anyone else would find bark.",
    choices: [
      { label: "Learn from the honey-takers", result: "Your foragers come back knowing which trees to climb and which roots to dig.", effects: [{ kind: "upgrade", upgrade: "beekeepers-lore" }] },
      { label: "Take the honey", result: "Twenty-five days of sweetness and bread, traded for the party's help with the smoke.", effects: [{ kind: "gain", gains: { grain: 25 } }] },
    ],
  },
  {
    id: "outlaws", site: "forest", title: "Outlaws of the Wood",
    text: "People outlawed by the captains live under the trees: poachers, debtors, a miller who argued with a reeve. They come out to look at you with their bows strung.",
    choices: [
      { label: "Pardon them in the king's name", result: "A pardon from an exile is worth what it is worth. Three of them think it worth following.", effects: [{ kind: "gain", gains: { levy: 3 } }, { kind: "legitimacy", delta: 1 }] },
      {
        label: "Drive them off", result: "They scatter, and leave their takings behind: six pennies.",
        effects: [{ kind: "gain", gains: { coin: 6 } }],
        chance: { pct: 60, fail: { result: "They do not scatter. A follower takes an arrow in the leg and is sent home on a borrowed mule.", effects: [{ kind: "lose", loss: { levy: 1 } }] } },
      },
      { label: "Leave them be", result: "You go round. The wood is theirs, for now.", effects: [] },
    ],
  },

  // -- coasts and waters -----------------------------------------------------------
  {
    id: "the-ferryman", site: "coast", title: "The Ferryman",
    text: "An old ferryman who once carried the court across the estuary knows your face at once, and weeps a little, and then talks about the price of rope.",
    choices: [
      { label: "Remember the old service", result: "Word goes up and down the water: the king's party crosses for nothing and waits for no one.", effects: [{ kind: "upgrade", upgrade: "ferrymans-favour" }] },
      { label: "Ask for news of the shore", result: "The ferryman knows every landing for a hundred miles, and names them all.", effects: [{ kind: "reveal", miles: 150 }] },
    ],
  },
  {
    id: "salt-pans", site: "coast", title: "The Salt Pans",
    text: "Salt workers rake the pans at low tide. Salted, they say, bread and meat keep through anything short of a flood.",
    choices: [
      { label: "Learn the salting", result: "The party carries the knowing of it home. Your stores will keep twice as long.", effects: [{ kind: "upgrade", upgrade: "salt-pans" }] },
      { label: "Trade labour for salt fish", result: "A day raking salt buys fifteen days of fish.", effects: [{ kind: "gain", gains: { grain: 15 } }] },
    ],
  },
  {
    id: "fish-weirs", site: "coast", title: "The Fish Weirs",
    text: "The fishers' weirs were smashed by the Crow's men for a debt the fishers say they never owed. Without them there is no catch to speak of.",
    choices: [
      { label: "Help mend the weirs (6 timber)", result: "The weirs stand again by nightfall. The fishers will send a share of every catch to the king.", effects: [{ kind: "pay", cost: { timber: 6 } }, { kind: "upgrade", upgrade: "fishers-weirs" }] },
      { label: "Buy what catch there is", result: "Twelve days of fish, dear for what it is.", effects: [{ kind: "gain", gains: { grain: 12 } }] },
    ],
  },

  // -- anywhere --------------------------------------------------------------------
  {
    id: "drovers", site: "any", title: "The Drovers",
    text: "Drovers are bringing cattle down to the autumn fairs by the green roads, the old ways the carts never use. They know every short cut in the kingdom.",
    choices: [
      { label: "Learn their roads", result: "The drovers show your people the old ways. Tracks and moor paths go quicker for it.", effects: [{ kind: "upgrade", upgrade: "drovers-roads" }] },
      { label: "Buy a beast (3 coin)", result: "One thin bullock: thirty days of meat for the party.", effects: [{ kind: "pay", cost: { coin: 3 } }, { kind: "gain", gains: { grain: 30 } }] },
    ],
  },
  {
    id: "lost-courier", site: "any", title: "A Courier Lost",
    text: "A courier in the Chancellor's colours has lost the road and a horse, and does not know who you are. The dispatch case is very well sealed.",
    choices: [
      { label: "Take the dispatches", result: "Lists of garrisons and the roads between them. Useful, and not the act of a king.", effects: [{ kind: "reveal", miles: 220 }, { kind: "legitimacy", delta: -1 }] },
      { label: "Set the courier on the right road", result: "The courier goes on, none the wiser. Later, wiser, the courier tells the story everywhere.", effects: [{ kind: "legitimacy", delta: 2 }] },
    ],
  },
  {
    id: "travellers-fire", site: "any", title: "Travellers at the Fire",
    text: "Travellers have a fire going and a pot on it, and make room. They are going nowhere in particular, which in these times is a kind of answer.",
    choices: [
      { label: "Share the pot (6 grain)", result: "By morning two of them have decided that following an exile is somewhere in particular.", effects: [{ kind: "pay", cost: { grain: 6 } }, { kind: "gain", gains: { levy: 2 } }] },
      { label: "Ask their news", result: "They have walked a long way, and they remember it.", effects: [{ kind: "reveal", miles: 100 }] },
    ],
  },
];

/** By id, for the sim and the card. */
export const STORY_EVENT_BY_ID: ReadonlyMap<string, StoryEventDef> = new Map(STORY_EVENTS.map((e) => [e.id, e]));

/** Hash and save code of an event is its index here. Append only. */
export const STORY_EVENT_IDS: readonly string[] = STORY_EVENTS.map((e) => e.id);
