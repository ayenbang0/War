/**
 * The tutorial (PLAN.md amendment 3, §B.11a K9): after the opening cutscene,
 * one lesson for every control in the game -- the kingdom map, the city view,
 * the battlefield's whole pen vocabulary, the camera, the clock and the keys,
 * event cards, and the armies' orders on the map (K4, PLAN §B.5).
 *
 * Told inside the story, not beside it: the map lessons are the exile's first
 * days at Cold Hearth, the town lessons are Rookstead, and the battle lessons
 * are the first followers drilling on the frozen field below it. The player
 * performs every stroke; nothing is scripted input.
 *
 * Each step says what to do (`text`), what counts as done (`success`, data
 * the K9 tutorial runner checks against what actually HAPPENED -- an order the
 * world accepted, a card that opened -- never merely what the recogniser
 * guessed, as the old lesson learned the hard way: src/ui/tutorial.ts), and a
 * `hint` shown when the player stalls. Text and hint are at most two sentences.
 *
 * validate-story.ts holds this table to "every control": every one of the
 * battle recogniser's classes (input/gestures.ts `Recognized`, all fourteen),
 * every formation glyph, every kingdom pen order of §B.5, the camera in every
 * layer, the clock, abilities, deployment, cities and event cards.
 */

import type { Recognized } from "../../input/gestures.ts";
import type { FormationShape } from "../../sim/formations.ts";

export type TutorialLayer = "kingdom" | "city" | "battle";

/** The battle pen's classes: exactly the recogniser's. */
export type BattleGestureClass = Recognized["kind"];

/**
 * Every battle class, as a record so that a fifteenth class added to the
 * recogniser fails to compile here until the tutorial teaches it.
 */
const BATTLE_CLASS_SET: Readonly<Record<BattleGestureClass, true>> = {
  select: true, move: true, attack: true, hold: true, formation: true, retreat: true, patrol: true,
  split: true, grid: true, patrolArea: true, recover: true, ambush: true, feint: true, lasso: true,
};
export const BATTLE_GESTURE_CLASSES = Object.keys(BATTLE_CLASS_SET) as readonly BattleGestureClass[];

/** The formation glyphs a stroke on a company can draw (input/gestures.ts matchFormationGlyph). */
export const GLYPH_SHAPES: readonly FormationShape[] = ["line", "column", "wedge", "square"];

/**
 * The kingdom map's pen vocabulary (PLAN §B.5): K2's march and taps, and
 * K4's army orders. Kept here as names because K4 is still writing the
 * recogniser; K9 maps each to its class.
 */
export type KingdomPenClass =
  | "tapHolding" | "tapToken" | "march" | "intercept" | "garrison" | "patrol" | "split" | "merge" | "recover";
export const KINGDOM_PEN_CLASSES: readonly KingdomPenClass[] = [
  "tapHolding", "tapToken", "march", "intercept", "garrison", "patrol", "split", "merge", "recover",
];

export type CameraAction = "drag" | "keys" | "zoom";
export type TimeAction = "pause" | "step" | "speed";

/** Panels, buttons and transitions a step can wait for. */
export type TutorialUiAction =
  | "forage" | "rally" | "claim" | "eventChoose" | "openFinds"
  | "enterCity" | "leaveCity" | "build" | "sow" | "openPolitics"
  | "deployDrag" | "beginBattle" | "cancelStroke" | "abilityArm" | "abilityCast"
  | "openArmyCard" | "fightContact"
  // K9 (the owner's list: "deploy", "zoom-through", "auto-resow", "tavern"),
  // controls ECON and K7 added after this table was first written.
  | "raiseArmy" | "zoomThrough" | "resowAll" | "openTavern";

export const TUTORIAL_UI_ACTIONS: readonly TutorialUiAction[] = [
  "forage", "rally", "claim", "eventChoose", "openFinds",
  "enterCity", "leaveCity", "build", "sow", "openPolitics",
  "deployDrag", "beginBattle", "cancelStroke", "abilityArm", "abilityCast",
  "openArmyCard", "fightContact",
  "raiseArmy", "zoomThrough", "resowAll", "openTavern",
];

export type TutorialSuccess =
  /** A battle stroke the world accepted. `detail` narrows it: a glyph's shape, a select that cleared or picked, a lasso that carved a company or took a group. */
  | { readonly kind: "gesture"; readonly class: BattleGestureClass; readonly shape?: FormationShape; readonly detail?: "cleared" | "picked" | "carve" | "group" }
  | { readonly kind: "kingdomGesture"; readonly class: KingdomPenClass }
  | { readonly kind: "cityTap"; readonly target: "lot" | "field" | "square" }
  | { readonly kind: "camera"; readonly action: CameraAction }
  | { readonly kind: "time"; readonly action: TimeAction }
  | { readonly kind: "key"; readonly code: string }
  | { readonly kind: "ui"; readonly action: TutorialUiAction };

export type TutorialStep = {
  readonly id: string;
  readonly layer: TutorialLayer;
  /** Which lesson it belongs to (TUTORIAL_LESSONS). */
  readonly lesson: string;
  readonly text: string;
  readonly success: TutorialSuccess;
  readonly hint: string;
};

export type TutorialLesson = {
  readonly id: string;
  readonly layer: TutorialLayer;
  readonly title: string;
  /** Read before the lesson's first step, in Brother Aldous's voice. */
  readonly intro: string;
};

export const TUTORIAL_LESSONS: readonly TutorialLesson[] = [
  { id: "map", layer: "kingdom", title: "The Map", intro: "Before anything else, the king had to learn where the Reach went. So did I." },
  { id: "town", layer: "city", title: "Rookstead", intro: "A holding is more than a dot on the map: it has lots to build on, fields to sow and people with opinions." },
  { id: "drill", layer: "battle", title: "The Frozen Field", intro: "The first followers drilled on the frozen field below Rookstead, with sticks for spears and the ledger for an audience." },
  { id: "armies", layer: "kingdom", title: "Armies on the Map", intro: "Once there was an army, it had to be told where to go, and whom to meet, and when to rest." },
];

const S = (
  id: string, layer: TutorialLayer, lesson: string, text: string, success: TutorialSuccess, hint: string,
): TutorialStep => ({ id, layer, lesson, text, success, hint });

export const TUTORIAL: readonly TutorialStep[] = [
  // -- the map (kingdom layer) ------------------------------------------------------
  S("map-drag", "kingdom", "map", "Hold the middle or right button and drag to look across the Reach.", { kind: "camera", action: "drag" },
    "The left button is the pen and never moves the map. Pushing the pointer against the window's edge pans too."),
  S("map-keys", "kingdom", "map", "Pan with W A S D or the arrow keys.", { kind: "camera", action: "keys" },
    "Any of the eight keys will do."),
  S("map-zoom", "kingdom", "map", "Roll the wheel to zoom about the pointer.", { kind: "camera", action: "zoom" },
    "The - and = keys zoom as well."),
  S("map-find", "kingdom", "map", "Press F to fly back to the king.", { kind: "key", code: "KeyF" },
    "Whenever you lose the king on the map, F finds them."),
  S("map-tap-holding", "kingdom", "map", "Tap Cold Hearth to read its card.", { kind: "kingdomGesture", class: "tapHolding" },
    "A short tap on a holding opens its card. A tap never gives an order."),
  S("map-tap-king", "kingdom", "map", "Tap the king's counter to see the party.", { kind: "kingdomGesture", class: "tapToken" },
    "The counter stands on a stem above Cold Hearth."),
  S("map-forage", "kingdom", "map", "On the king's card, choose Forage here.", { kind: "ui", action: "forage" },
    "The party gathers grain every day until it moves or takes up another task."),
  S("map-pause", "kingdom", "map", "Press space to stop the realm's clock.", { kind: "time", action: "pause" },
    "Space again starts it."),
  S("map-step", "kingdom", "map", "With the clock stopped, press . to step one day.", { kind: "time", action: "step" },
    "Stepping only works while the clock is stopped."),
  S("map-speed", "kingdom", "map", "Press 1, 2 or 3 to run the realm at one, two or four times speed.", { kind: "time", action: "speed" },
    "Choosing a speed also starts the clock."),
  S("map-march", "kingdom", "map", "Draw a line from the king's counter to Greyshaw to march there.", { kind: "kingdomGesture", class: "march" },
    "Start the stroke on the counter and let go over Greyshaw. The ghost shows the road and how long it will take."),
  S("map-rally", "kingdom", "map", "At Greyshaw, choose Rally followers on the king's card.", { kind: "ui", action: "rally" },
    "Followers are rallied only at hamlets nobody has claimed."),
  S("map-claim", "kingdom", "map", "With three followers, march to Rookstead and claim it.", { kind: "ui", action: "claim" },
    "The king has to be standing there, with hands enough to hold it."),
  S("map-letter", "kingdom", "map", "A letter has come: read it, then choose an answer.", { kind: "ui", action: "eventChoose" },
    "Esc lays a letter aside to decide later. The realm waits while you read."),
  S("map-finds", "kingdom", "map", "Open Finds in the top bar to see what waits there.", { kind: "ui", action: "openFinds" },
    "Letters set aside and special upgrades found are kept there."),

  // -- the town (city layer) --------------------------------------------------------
  S("town-enter", "city", "town", "Roll the wheel in over Rookstead, on past the closest zoom, to go down into the town.", { kind: "ui", action: "zoomThrough" },
    "Keep rolling once the map stops getting closer. Only a holding of yours lets you in."),
  S("town-look", "city", "town", "Drag with the middle or right button to look round the town.", { kind: "camera", action: "drag" },
    "The map's camera keys work here too."),
  S("town-zoom", "city", "town", "Roll the wheel to look closer at the lots.", { kind: "camera", action: "zoom" },
    "Press F to see the whole town at once."),
  S("town-lot", "city", "town", "Tap a lot to see what can be built there.", { kind: "cityTap", target: "lot" },
    "The town builds outward from its square, one lot at a time."),
  S("town-build", "city", "town", "Choose Build and pick a building.", { kind: "ui", action: "build" },
    "A building the stores cannot pay for is still listed, with what it needs."),
  S("town-field", "city", "town", "Tap one of the fields outside the walls.", { kind: "cityTap", target: "field" },
    "Fields lie round the edge of the plan."),
  S("town-sow", "city", "town", "Sow the field with something that grows in this season.", { kind: "ui", action: "sow" },
    "Seed is paid when it goes in, and the harvest comes with the season."),
  S("town-resow", "city", "town", "In the town's panel, turn on Resow all fields, so every field is sown again after its harvest.", { kind: "ui", action: "resowAll" },
    "The realm's fields then sow themselves with the chosen crop, as long as there is seed."),
  S("town-tavern", "city", "town", "Tap the tavern's lot and choose Free companies to see who is for hire.", { kind: "ui", action: "openTavern" },
    "A tavern is where the free companies drink. Hiring one costs coin now and pay every season."),
  S("town-square", "city", "town", "Tap the square to open the town's politics.", { kind: "cityTap", target: "square" },
    "Tax is set here; P opens it too."),
  S("town-politics-key", "city", "town", "Close it, then press P to open politics again.", { kind: "ui", action: "openPolitics" },
    "P is the shortcut anywhere in a town."),
  S("town-whole", "city", "town", "Press F to see the whole town.", { kind: "key", code: "KeyF" },
    "F frames the town, as it finds the king on the map."),
  S("town-leave", "city", "town", "Press Esc, or zoom out past the widest view, to go back to the map.", { kind: "ui", action: "leaveCity" },
    "Holding - at the widest view leaves too."),
  S("town-back", "city", "town", "Double-tap Rookstead on the map, or open its card and choose Enter the city.", { kind: "ui", action: "enterCity" },
    "Both ways in lead to the same town. Then press Esc to come back out."),
  S("town-out", "city", "town", "Press Esc to come back to the map.", { kind: "ui", action: "leaveCity" },
    "The drill comes next, on the frozen field below the town."),

  // -- the frozen field (battle layer) ------------------------------------------------
  S("drill-deploy", "battle", "drill", "Before the drill begins, drag one of your companies inside your deployment ground.", { kind: "ui", action: "deployDrag" },
    "A stroke that starts on a company carries it. A short touch only selects it."),
  S("drill-begin", "battle", "drill", "Press Enter to begin.", { kind: "ui", action: "beginBattle" },
    "Nothing moves until the battle begins."),
  S("drill-drag", "battle", "drill", "Drag with the middle or right button to look over the field.", { kind: "camera", action: "drag" },
    "Pushing against the window's edge pans too."),
  S("drill-keys", "battle", "drill", "Pan with W A S D or the arrows.", { kind: "camera", action: "keys" },
    "The camera never takes the left button."),
  S("drill-zoom", "battle", "drill", "Roll the wheel to zoom about the pointer.", { kind: "camera", action: "zoom" },
    "A stroke means the same thing at every zoom."),
  S("drill-lasso", "battle", "drill", "With nothing selected, draw a loop round some of your followers to make them a company.", { kind: "gesture", class: "lasso" },
    "A closed loop with nothing selected gathers everyone inside it. It is the only way a company is made."),
  S("drill-clear", "battle", "drill", "Tap empty ground to let the company go.", { kind: "gesture", class: "select", detail: "cleared" },
    "Nothing selected means the next loop makes a company instead of giving an order."),
  S("drill-pick", "battle", "drill", "Tap the company to pick it up again.", { kind: "gesture", class: "select", detail: "picked" },
    "Orders go to whatever you are holding."),
  S("drill-move", "battle", "drill", "Draw a line from the company out across the field.", { kind: "gesture", class: "move" },
    "A stroke drawn away from a company is a march. It finds its own way round rivers and woods."),
  S("drill-line", "battle", "drill", "Draw a short stroke across the company's front, right on top of it.", { kind: "gesture", class: "formation", shape: "line" },
    "A glyph drawn on your own soldiers re-forms them. Across the front makes a line."),
  S("drill-column", "battle", "drill", "Now draw along the company's axis, on top of it.", { kind: "gesture", class: "formation", shape: "column" },
    "Along the way they face makes a column."),
  S("drill-wedge", "battle", "drill", "Draw a chevron on the company.", { kind: "gesture", class: "formation", shape: "wedge" },
    "A real point, not a lazy bend, makes a wedge."),
  S("drill-square", "battle", "drill", "Draw a small box on the company.", { kind: "gesture", class: "formation", shape: "square" },
    "A box drawn on the company forms a square. The same box out on the field means hold."),
  S("drill-hold", "battle", "drill", "Draw a small loop out on open ground.", { kind: "gesture", class: "hold" },
    "A small closed loop holds that ground and chases nothing beyond it."),
  S("drill-patrol", "battle", "drill", "Draw a big ring somewhere on the field.", { kind: "gesture", class: "patrol" },
    "A large circuit is a patrol: the company walks it until told otherwise."),
  S("drill-retreat", "battle", "drill", "Draw a line from the company back toward your own edge.", { kind: "gesture", class: "retreat" },
    "A retreat leads away from the enemy and toward home. The ghost says retreat before you let go."),
  S("drill-feint", "battle", "drill", "Draw a march, then at once draw back along the same route.", { kind: "gesture", class: "feint" },
    "Retracing the route just drawn makes a feint: a real advance, honestly withdrawn."),
  S("drill-ambush", "battle", "drill", "Draw a zigzag on the company.", { kind: "gesture", class: "ambush" },
    "Three or more sharp turns lay an ambush: the company keeps still and holds its fire until someone walks in."),
  S("drill-carve", "battle", "drill", "Tap empty ground, then draw a loop round only part of a company.", { kind: "gesture", class: "lasso", detail: "carve" },
    "The soldiers inside the loop become a company of their own. That is how a company is split."),
  S("drill-group", "battle", "drill", "With nothing selected, draw a loop round two companies to take them both.", { kind: "gesture", class: "lasso", detail: "group" },
    "Two or more companies held at once are a group, and a group has strokes of its own."),
  S("drill-split", "battle", "drill", "With the group held, draw a straight line clear of them.", { kind: "gesture", class: "split" },
    "Companies left of the stroke stay held. Draw it the other way to keep the other half."),
  S("drill-grid", "battle", "drill", "Take the group again, draw a line, then a second line beside it within a second.", { kind: "gesture", class: "grid" },
    "Two parallel lines lay the group out in rows and columns on the two rails."),
  S("drill-cordon", "battle", "drill", "With the group held, draw a large circle.", { kind: "gesture", class: "patrolArea" },
    "The group spreads round one ring as a patrol cordon."),
  S("drill-recover", "battle", "drill", "Draw a heart over a company.", { kind: "gesture", class: "recover" },
    "A heart stands it down for thirty seconds to mend. It takes no orders until then."),
  S("drill-arm", "battle", "drill", "Press 1 to ready the first ability on the bar.", { kind: "ui", action: "abilityArm" },
    "Keys 1 to 9, 0, - and = each hold one ability. Esc puts a readied ability away."),
  S("drill-cast", "battle", "drill", "Now draw a stroke to say where it goes.", { kind: "ui", action: "abilityCast" },
    "The left button still only ever points."),
  S("drill-cancel", "battle", "drill", "Start a stroke, and press Esc before you let go.", { kind: "ui", action: "cancelStroke" },
    "Esc abandons a stroke being drawn. With nothing to abandon it asks whether to leave."),
  S("drill-pause", "battle", "drill", "Press space to pause the battle.", { kind: "time", action: "pause" },
    "Space again resumes it."),
  S("drill-step", "battle", "drill", "While paused, press . to step forward a moment.", { kind: "time", action: "step" },
    "Stepping lets you watch a charge land one beat at a time."),
  S("drill-attack", "battle", "drill", "Last one: draw a stroke from a company that ends on the enemy.", { kind: "gesture", class: "attack" },
    "A stroke that ends on an enemy company is an attack, whatever its shape."),

  // -- armies on the map (kingdom layer, K4) ---------------------------------------
  S("army-raise", "kingdom", "armies", "On the king's card, choose Raise followers and raise a company from the levy.", { kind: "ui", action: "raiseArmy" },
    "Followers who are not in an army only eat. Raised, they march, fight and draw pay."),
  S("army-card", "kingdom", "armies", "Tap one of your armies to read its card.", { kind: "ui", action: "openArmyCard" },
    "The card shows its companies, its bread and its pay."),
  S("army-garrison", "kingdom", "armies", "Draw a small ring on a holding of yours where an army stands.", { kind: "kingdomGesture", class: "garrison" },
    "The army digs in and holds it."),
  S("army-patrol", "kingdom", "armies", "Draw a large ring round several holdings to patrol and screen them.", { kind: "kingdomGesture", class: "patrol" },
    "The army rides the ring and warns of anything coming in."),
  S("army-split", "kingdom", "armies", "Draw a line across an army to split it in two.", { kind: "kingdomGesture", class: "split" },
    "Each half keeps its own bread and pay."),
  S("army-merge", "kingdom", "armies", "Draw a stroke from one of your armies to another to merge them.", { kind: "kingdomGesture", class: "merge" },
    "They must stand in the same place to join."),
  S("army-recover", "kingdom", "armies", "Draw a heart on an army to rest and mend it where it stands.", { kind: "kingdomGesture", class: "recover" },
    "The wounded mend faster in a town with a hall or healers."),
  S("army-intercept", "kingdom", "armies", "Draw a line from your army to an enemy army to intercept it.", { kind: "kingdomGesture", class: "intercept" },
    "The army goes to meet the enemy on the road, wherever it has got to."),
  S("army-fight", "kingdom", "armies", "When armies meet, choose Fight to go down to the battlefield.", { kind: "ui", action: "fightContact" },
    "Withdrawing costs a rearguard. Resolving it without you is quicker, and worse on average."),
];
