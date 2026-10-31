import { GpuSplatMath, GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';

const {
    cos,
    dot,
    float,
    fract,
    hash,
    max,
    min,
    mix,
    mx_noise_float,
    normalize,
    pow,
    sin,
    smoothstep,
    step,
    time,
    uint,
    uniform,
    uniformArray,
    vec2,
    vec3,
    vec4,
} = TSL;

// A little kitchen at work. A basket of stock vegetables (carrots, onions, celery) sits on the counter under the
// copper pans: E there picks one up and you carry it. At the far end of the big table a chopping board, a knife and a
// copper stock pot: E on the empty board lays your vegetable down, E then chops it a slice at a time, F sweeps the
// slices and the stub into the pot, where they float and colour the stock. All splats, worked out per splat from a
// few numbers on the CPU: what's in your hand, what's on the board, how many chops, how long since each thing.
//
// Building props from splats so they don't read as circles: soft splats lying in the surface, overlapping so their
// colours melt together, each nudged inside its own cell; outlines crisp because the splats are paper thin and seen
// side on there, with hairlines only where an edge is flat; every mark finer than a splat (a crease, a scratch, a
// ring in an onion) drawn by its own thin splats laid along it.

// Where the table's top is at this end, and the way you face standing there: the board's things are laid out along
// it (`along`, left to right as you look) and towards you (`toward`).
const TABLE = 1.128;
const TURN = -2.094;
// As crisp as the renderer draws a splat: opacities past 1 sharpen its edge instead of growing it, up to 2.
const CRISP = 2;

const BOARD = {
    centre: [-3.135, TABLE, -2.33] as const,
    length: 0.62,
    width: 0.31,
    thickness: 0.028,
    corner: 0.03,
    // The top: grain rows, this many across and this many along each, inside a rounded-over rim this wide that's
    // traced in rings; then the side in bands, all round the outline in this many steps.
    rim: 0.012,
    rows: 68,
    runs: 96,
    rings: 6,
    around: 300,
    bands: 5,
    // Glued up from this many strips; a juice groove in from the edge, and how wide.
    strips: 5,
    groove: [0.024, 0.005],
    // Old, weathered wood gone a soft grey-taupe like the table's other board, its grain faint; darker stains, and
    // grime worked into its edges.
    wood: [0.56, 0.48, 0.43],
    grain: [0.46, 0.39, 0.35],
    stain: [0.36, 0.29, 0.25],
    // Years of knife work: pale scratches criss-crossing it, mostly across the grain, thickest in the middle; one
    // split opening along a seam; a few crumbs of herbs left on it.
    scratches: 340,
    scratchRun: 6,
    scratch: [0.74, 0.68, 0.62],
    split: 40,
    crumbs: 9,
};

// The vegetables, each a body round an axis from its top (s = 0) to its end (s = 1): its length and thickness, how
// much is left when it's chopped down; its skin's colours top, middle and end; the marks on it, which run round it
// (a carrot's growth rings) or along it (an onion's papery veins, celery's ridges) and are darker or lighter; its top
// (a carrot's cut stalks, an onion's dry neck, celery's leaves); and inside, its middle and outer colours.
const KINDS = ['carrot', 'onion', 'celery'] as const;
type Kind = (typeof KINDS)[number];
const VEG = {
    carrot: {
        length: 0.2,
        radius: 0.02,
        stub: 0.04,
        top: [0.42, 0.3, 0.1],
        skin: [0.78, 0.34, 0.1],
        end: [0.86, 0.48, 0.2],
        marksAlong: 0,
        marks: 0.55,
        tops: 6,
        topLength: [0.0022, 0.004],
        topWidth: 0.0013,
        topSpread: 0.3,
        topColour: [0.36, 0.42, 0.18],
        core: [1, 0.74, 0.34],
        flesh: [0.94, 0.44, 0.1],
        rings: 1,
        tint: [0.85, 0.45, 0.12],
    },
    onion: {
        length: 0.075,
        radius: 0.036,
        stub: 0.02,
        top: [0.42, 0.26, 0.13],
        skin: [0.64, 0.38, 0.17],
        end: [0.5, 0.31, 0.16],
        marksAlong: 1,
        marks: 0.62,
        tops: 7,
        topLength: [0.005, 0.009],
        topWidth: 0.0018,
        topSpread: 0.15,
        topColour: [0.6, 0.45, 0.26],
        core: [0.86, 0.9, 0.68],
        flesh: [0.95, 0.92, 0.82],
        rings: 5,
        tint: [0.86, 0.72, 0.42],
    },
    celery: {
        length: 0.24,
        radius: 0.011,
        stub: 0.04,
        top: [0.45, 0.6, 0.25],
        skin: [0.56, 0.7, 0.34],
        end: [0.74, 0.8, 0.52],
        marksAlong: 1,
        marks: 1.18,
        tops: 12,
        topLength: [0.01, 0.022],
        topWidth: 0.005,
        topSpread: 0.7,
        topColour: [0.32, 0.5, 0.17],
        core: [0.82, 0.88, 0.62],
        flesh: [0.7, 0.82, 0.5],
        rings: 0,
        tint: [0.55, 0.65, 0.3],
    },
} as const;
// A vegetable's splats, the same budget for every kind: its skin in rings of soft splats, its marks as runs of thin
// ones, a few pores (a carrot's), and its top.
const SKIN = { rings: 90, around: 24, marks: 8, markRun: 28, pores: 50, tops: 12 };
const SKIN_SPLATS = SKIN.rings * SKIN.around;
const MARKS = SKIN.marks * SKIN.markRun;
const PER_VEG = SKIN_SPLATS + MARKS + SKIN.pores + SKIN.tops;
// Every slice is this thick; chopped down to its stub, each kind gives this many.
const SLICE = 0.007;
const chopsOf = (kind: Kind) => Math.floor((VEG[kind].length - VEG[kind].stub) / SLICE);
const MAX_CHOPS = Math.max(...KINDS.map(chopsOf));
// Where a vegetable on the board lies: its end on the right where the knife works, this far along, and this far back.
const LIES = { end: 0.2, back: -0.06 };
// A coin's fall: seconds to topple over once the blade's through.
const COIN = { fall: 0.22 };

// The basket: an oval of woven willow on the counter under the copper pans, its strands in rows going in and out
// round the stakes, a rolled rim on top. Each kind in its own heap in it, left to right.
const BASKET = {
    centre: [-2.45, 1.016, -5.62] as const,
    turn: -0.38,
    length: 0.42,
    width: 0.28,
    height: 0.1,
    flare: 0.1,
    rows: 14,
    around: 150,
    stakes: 30,
    floor: 6,
    rimRings: 3,
    // Old willow gone grey-brown: each strand its own shade, some bleached, some dark; grime in blotches and dust down
    // in the weave and toward the base; the rim darkened by hands; a few broken ends sticking out.
    wicker: [0.47, 0.39, 0.3],
    shade: [0.17, 0.13, 0.1],
    bleached: [0.58, 0.54, 0.47],
    dust: [0.42, 0.4, 0.36],
    broken: 46,
    // What's in it: the kind, where (metres along and across from the middle), how high, which way it lies, and how
    // steeply it leans (celery propped up, its leaves out over the rim).
    items: [
        { kind: 'carrot', at: [-0.08, -0.035], lift: 0, twist: -0.1 },
        { kind: 'carrot', at: [-0.075, 0.0], lift: 0, twist: 0.05 },
        { kind: 'carrot', at: [-0.08, 0.04], lift: 0, twist: 0.12 },
        { kind: 'carrot', at: [-0.065, 0.015], lift: 0.035, twist: -0.12 },
        { kind: 'onion', at: [0.045, -0.055], lift: 0, twist: 0.8 },
        { kind: 'onion', at: [0.06, 0.03], lift: 0, twist: -0.6 },
        { kind: 'onion', at: [0.055, -0.012], lift: 0.05, twist: 1.6 },
        { kind: 'celery', at: [0.09, 0.0], lift: 0.05, twist: 0.12, pitch: 0.42 },
        { kind: 'celery', at: [0.11, 0.03], lift: 0.06, twist: -0.1, pitch: 0.38 },
    ] as { kind: Kind; at: [number, number]; lift: number; twist: number; pitch?: number }[],
};
// Where each kind is picked from: the middle of its heap, in basket terms.
const HEAPS: Record<Kind, [number, number]> = { carrot: [-0.075, 0.005], onion: [0.055, -0.01], celery: [0.12, 0.02] };

// The arched window at the back of the room, the brightest thing the copper sees, as a direction from the table.
const WINDOW = normalize(vec3(0.16, 0.2, -0.97));
// The stock pot: a big hammered-copper pot, about as tall as it is wide, tinned inside, a rolled bead round its rim,
// a loop handle riveted to each side. Stock in it a little over half full, rising as things go in, its colour from
// what's in it.
const POT = {
    centre: [-3.324, TABLE, -1.875] as const,
    radius: 0.12,
    height: 0.2,
    wall: 0.004,
    // Its wall is straight up and down and only curves round, so it's drawn in tall strips: this many round it, each
    // this many splats up it; the inside the same, down to below the stock.
    strips: 200,
    segments: 14,
    inner: 140,
    innerSegments: 8,
    bead: { around: 320, tube: 12, radius: 0.005 },
    // The hammer's facets catching the light, one glint each.
    glints: 160,
    // Copper's own colour, darkened with age toward the base; what it reflects, the dim room and the bright window;
    // the tin lining.
    copper: [0.56, 0.35, 0.25],
    patina: [0.26, 0.18, 0.14],
    room: [0.26, 0.19, 0.15],
    window: [0.9, 0.78, 0.66],
    // Years of use: dull tarnish in blotches, dark streaks run down from the rim, soot up from the base where it's
    // stood on the fire, a few specks of verdigris.
    tarnish: [0.3, 0.24, 0.21],
    soot: [0.07, 0.055, 0.05],
    verdigris: [0.32, 0.44, 0.38],
    tin: [0.5, 0.5, 0.48],
    level: 0.62,
    rise: 0.18,
    water: [0.42, 0.38, 0.28],
    // Each handle a cast loop standing out from the side (its reach, span, and tube thickness), on a riveted plate.
    handle: { along: 64, tube: 10, reach: 0.034, span: 0.07, thickness: 0.0042, height: 0.8 },
    // Little drops of fat on the stock's surface.
    fat: 46,
    // Room for this many slices floating on the stock.
    slots: 72,
};
// A chef's knife: blade length; tall at the heel, the spine falling and the edge curving up to meet it at the point,
// this high; the handle's length and half-thickness each way.
const KNIFE = {
    blade: 0.18,
    height: 0.044,
    point: 0.22,
    handle: 0.115,
    girth: [0.011, 0.0075],
    // A chop: seconds for the heel to come down through the cut, and to lift back up; each a little quicker for every
    // press still waiting, and with presses waiting it only lifts this far before coming down again, so mashing E
    // turns into quick short chops. Picked up over `over`; with no chopping it hovers `linger` seconds, then is laid
    // down over `settle`.
    down: 0.08,
    up: 0.18,
    rechop: 0.45,
    over: 0.14,
    linger: 1,
    settle: 0.3,
    // Held, it rocks on its tip: the heel lifted this far (radians) clear of the vegetable, swung down through it
    // with a little forward slice (metres).
    rock: 0.34,
    slice: 0.012,
    // Lying on the board at rest: where its heel is (metres along and toward). Held, it comes in at a slant (radians
    // off square to the vegetable), handle front right in your right hand, so you see the blade.
    lying: [0.21, 0.11],
    slant: 0.5,
    steel: { edge: [0.72, 0.73, 0.75], bevel: [0.56, 0.57, 0.6], face: [0.44, 0.45, 0.48], spine: [0.3, 0.31, 0.33] },
    wood: [0.3, 0.18, 0.1],
};
// Sweeping, seconds in: the slices fly into the pot over `time`; the stub follows. Laying a vegetable down drops it
// onto the board over `place`.
// Into the pot: each slice tossed in turn (all of them launched within `spread` seconds), flying a high arc for
// `flight`, tumbling; the stub last. Laying a vegetable down drops it onto the board over `place`.
const SWEEP = { spread: 0.55, flight: 0.5, stub: 0.6, stubFlight: 0.55, apex: 0.06, place: 0.28 };
const SWEEP_DONE = SWEEP.stub + SWEEP.stubFlight;
// When coin `coin` of `count` lands.
const landsAt = (coin: number, count: number) => (coin / Math.max(count, 1)) * SWEEP.spread + SWEEP.flight;
// Carrying: where your vegetable rides, in front of you (metres right, down, ahead), and how much it sways as you
// walk; how long it takes to come up into your hand.
const HAND = { at: [0.13, -0.12, 0.34], sway: 0.006, raise: 0.18 };
const REACH = { distance: 2.2, angle: 0.4 };

type Uniform<T> = TslNode & { value: T };

export type Prep = {
    objects: SplatObject[];
    // In your hand: which kind (-1 nothing), since when, and where it rides.
    holding: Kind | null;
    heldKind: Uniform<number>;
    sinceHeld: Uniform<number>;
    hand: Uniform<THREE.Vector3>;
    // Where you're looking from, for what the copper reflects.
    eye: Uniform<THREE.Vector3>;
    handDir: Uniform<THREE.Vector3>;
    heldAt: number;
    // On the board: which kind (-1 nothing), how many chops, since when.
    boardKind: Uniform<number>;
    sincePlaced: Uniform<number>;
    placedAt: number;
    chops: Uniform<number>;
    // Since the last slice came off (the blade's last contact).
    sinceChop: Uniform<number>;
    choppedAt: number;
    // The knife's stroke: 0 heel up, 1 on the board; which way it's going; presses not yet cut; where along the
    // vegetable it's over, in slices.
    stroke: Uniform<number>;
    going: 'down' | 'up' | 'still';
    pending: number;
    knifeAt: Uniform<number>;
    // How far the knife is in hand, 0 lying at rest to 1 held over the vegetable.
    grip: Uniform<number>;
    // The last sweep: what kind, how many slices, since when; slices in the pot before it.
    sweptKind: Uniform<number>;
    swept: Uniform<number>;
    sinceSweep: Uniform<number>;
    sweptAt: number;
    before: Uniform<number>;
    inPot: Uniform<number>;
    slotKinds: { array: number[]; needsUpdate?: boolean } & TslNode;
    stock: Uniform<THREE.Vector3>;
    seed: Uniform<number>;
    lastSeed: Uniform<number>;
    clock: number;
    held: Set<string>;
    prompt: { box: HTMLElement; use: HTMLElement; replace: HTMLElement; showing: string };
    sound: Sound | null;
};

// The way you face at this end of the table, and the way across it: along runs left to right, toward runs at you.
const ALONG = new THREE.Vector3(Math.cos(TURN), 0, -Math.sin(TURN));
const TOWARD = new THREE.Vector3(Math.sin(TURN), 0, Math.cos(TURN));
const along = vec3(ALONG.x, ALONG.y, ALONG.z);
const toward = vec3(TOWARD.x, TOWARD.y, TOWARD.z);
const up = vec3(0, 1, 0);
// The basket's own directions, along the counter and out from the wall.
const BASKET_ALONG = new THREE.Vector3(Math.cos(BASKET.turn), 0, -Math.sin(BASKET.turn));
const BASKET_OUT = new THREE.Vector3(Math.sin(BASKET.turn), 0, Math.cos(BASKET.turn));
// The light the props are shaded by: from above, a little from the window side.
const light = normalize(vec3(0.3, 1, 0.45));
// A point on the board: metres along it, toward you, and up from its top.
const onBoard = (a: TslNode | number, b: TslNode | number, h: TslNode | number): TslNode =>
    vec3(...BOARD.centre)
        .add(along.mul(a))
        .add(toward.mul(b))
        .add(vec3(0, float(h).add(BOARD.thickness), 0));
// A point in the basket, in its own terms.
const inBasket = (a: number, b: number, h: number): THREE.Vector3 =>
    new THREE.Vector3(...BASKET.centre)
        .addScaledVector(BASKET_ALONG, a)
        .addScaledVector(BASKET_OUT, b)
        .add(new THREE.Vector3(0, h, 0));

export function initPrep(): Prep {
    const box = document.getElementById('prompt') as HTMLElement;
    const prep: Prep = {
        objects: [],
        holding: null,
        heldKind: uniform(-1) as Uniform<number>,
        sinceHeld: uniform(0) as Uniform<number>,
        hand: uniform(new THREE.Vector3()) as Uniform<THREE.Vector3>,
        eye: uniform(new THREE.Vector3()) as Uniform<THREE.Vector3>,
        handDir: uniform(new THREE.Vector3(1, 0, 0)) as Uniform<THREE.Vector3>,
        heldAt: -1e6,
        boardKind: uniform(-1) as Uniform<number>,
        sincePlaced: uniform(1e6) as Uniform<number>,
        placedAt: -1e6,
        chops: uniform(0) as Uniform<number>,
        sinceChop: uniform(1e6) as Uniform<number>,
        choppedAt: -1e6,
        stroke: uniform(0) as Uniform<number>,
        going: 'still',
        pending: 0,
        knifeAt: uniform(1) as Uniform<number>,
        grip: uniform(0) as Uniform<number>,
        sweptKind: uniform(0) as Uniform<number>,
        swept: uniform(0) as Uniform<number>,
        sinceSweep: uniform(1e6) as Uniform<number>,
        sweptAt: -1e6,
        before: uniform(0) as Uniform<number>,
        inPot: uniform(0) as Uniform<number>,
        slotKinds: uniformArray(new Array(POT.slots).fill(0), 'float') as Prep['slotKinds'],
        stock: uniform(new THREE.Vector3(...POT.water)) as Uniform<THREE.Vector3>,
        seed: uniform(3.1) as Uniform<number>,
        lastSeed: uniform(3.1) as Uniform<number>,
        clock: 0,
        held: new Set(),
        prompt: {
            box,
            use: box.querySelector('.use') as HTMLElement,
            replace: box.querySelector('.replace') as HTMLElement,
            showing: '',
        },
        sound: null,
    };
    prep.objects = [
        shadows(),
        board(),
        boardMarks(),
        boardVeg(prep),
        stub(prep),
        coins(prep),
        knife(prep),
        basket(),
        basketVeg(),
        heldVeg(prep),
        pot(prep),
        stock(prep),
        potSlices(prep),
        splashes(prep),
    ];
    return prep;
}

const toward3 = new THREE.Vector3();
const looking = new THREE.Vector3();
const right = new THREE.Vector3();
const lift = new THREE.Vector3();
const boardMiddle = new THREE.Vector3(BOARD.centre[0], TABLE + BOARD.thickness, BOARD.centre[2]);
const basketMiddle = inBasket(0, 0, BASKET.height * 0.6);

// How far off your aim a point is (radians), or Infinity out of reach.
function aimAt(camera: THREE.Camera, point: THREE.Vector3): number {
    toward3.subVectors(point, camera.position);
    return toward3.length() < REACH.distance ? looking.angleTo(toward3) : Number.POSITIVE_INFINITY;
}

export function updatePrep(prep: Prep, keys: Set<string>, camera: THREE.Camera, dt: number): void {
    prep.clock += dt;
    camera.getWorldDirection(looking);
    const pressed = (key: string) => keys.has(key) && !prep.held.has(key);
    const onBoardKind = prep.boardKind.value >= 0 ? KINDS[prep.boardKind.value] : null;
    const chopsLeft = onBoardKind ? prep.chops.value < chopsOf(onBoardKind) : false;

    let use: string | null = null;
    let replace: string | null = null;
    const atBoard = aimAt(camera, boardMiddle) < REACH.angle;
    const atBasket = !atBoard && aimAt(camera, basketMiddle) < REACH.angle;
    if (atBasket) {
        // The heap you're looking at most squarely.
        let nearest: Kind = 'carrot';
        let best = Number.POSITIVE_INFINITY;
        for (const kind of KINDS) {
            const off = aimAt(camera, inBasket(...HEAPS[kind], BASKET.height * 0.7));
            if (off < best) [best, nearest] = [off, kind];
        }
        if (prep.holding) {
            use = 'put back';
            if (pressed('KeyE')) take(prep, null);
        } else {
            use = `take ${nearest}`;
            if (pressed('KeyE')) take(prep, nearest);
        }
    } else if (atBoard) {
        if (prep.holding && !onBoardKind) {
            use = `lay down ${prep.holding}`;
            if (pressed('KeyE')) {
                prep.boardKind.value = KINDS.indexOf(prep.holding);
                prep.chops.value = 0;
                prep.choppedAt = -1e6;
                prep.pending = 0;
                prep.knifeAt.value = 1;
                prep.placedAt = prep.clock;
                prep.seed.value = Math.random() * 100;
                take(prep, null);
                prep.sound?.place();
            }
        } else if (chopsLeft) {
            use = 'chop';
            // Every press is a chop: the knife heads down from wherever it is.
            if (pressed('KeyE') && prep.chops.value + prep.pending < chopsOf(onBoardKind as Kind)) {
                prep.pending += 1;
                prep.going = 'down';
            }
        }
        if (onBoardKind && prep.chops.value > 0) {
            replace = 'into the pot';
            if (pressed('KeyF')) sweep(prep);
        }
    }
    driveKnife(prep, onBoardKind, dt);
    showPrompt(prep.prompt, use, replace);
    prep.held = new Set(['KeyE', 'KeyF'].filter((key) => keys.has(key)));

    prep.sinceChop.value = prep.clock - prep.choppedAt;
    prep.sinceSweep.value = prep.clock - prep.sweptAt;
    prep.sincePlaced.value = prep.clock - prep.placedAt;
    prep.sinceHeld.value = prep.clock - prep.heldAt;
    // The sweep's slices join the pot's as they land.
    if (prep.sinceSweep.value > SWEEP.spread + SWEEP.flight + 0.05)
        prep.inPot.value = Math.min(POT.slots, prep.before.value + prep.swept.value);
    // Picked up quickly when you chop, kept in hand while you're chopping, laid down a moment after you stop.
    const inHand = prep.going !== 'still' || prep.sinceChop.value < KNIFE.linger;
    const change = inHand ? dt / KNIFE.over : -dt / KNIFE.settle;
    prep.grip.value = Math.min(1, Math.max(0, prep.grip.value + change));

    prep.eye.value.copy(camera.position);
    // Your vegetable rides low on your right, lying across your view, swaying a little.
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    lift.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const sway = Math.sin(prep.clock * 2.1) * HAND.sway;
    prep.hand.value
        .copy(camera.position)
        .addScaledVector(right, HAND.at[0])
        .addScaledVector(lift, HAND.at[1] + sway)
        .addScaledVector(looking, HAND.at[2]);
    prep.handDir.value.copy(right).multiplyScalar(-0.55).addScaledVector(looking, 0.8).addScaledVector(lift, 0.1).normalize();
}

// The knife's stroke, moved on each frame so it never jumps: down to the board, a slice off at contact, back up;
// with presses waiting it turns round partway up and comes down again, quicker for each one waiting. Between strokes
// it slides along to the next cut.
function driveKnife(prep: Prep, kind: Kind | null, dt: number): void {
    const hurry = 1 + prep.pending * 0.6;
    const stroke = prep.stroke;
    if (prep.going === 'down') {
        stroke.value = Math.min(1, stroke.value + (dt / KNIFE.down) * hurry);
        if (stroke.value >= 1) {
            prep.pending -= 1;
            prep.chops.value += 1;
            prep.choppedAt = prep.clock;
            prep.going = 'up';
            prep.sound?.chop();
        }
    } else if (prep.going === 'up') {
        stroke.value = Math.max(0, stroke.value - (dt / KNIFE.up) * hurry);
        if (prep.pending > 0 && stroke.value <= KNIFE.rechop) prep.going = 'down';
        else if (stroke.value <= 0) prep.going = 'still';
    }
    if (!kind) {
        prep.pending = 0;
        prep.going = stroke.value > 0 ? 'up' : 'still';
    }
    // Over the next cut while lifting, slid there quickly.
    const target = kind ? Math.min(prep.chops.value + 1, chopsOf(kind)) : 1;
    prep.knifeAt.value += (target - prep.knifeAt.value) * (1 - Math.exp(-dt * 30));
}

// Something into your hand, or your hand emptied.
function take(prep: Prep, kind: Kind | null): void {
    prep.holding = kind;
    prep.heldKind.value = kind ? KINDS.indexOf(kind) : -1;
    prep.heldAt = prep.clock;
    if (kind) prep.sound?.place();
}

// The board's slices and stub into the pot, the board left empty; the stock takes on their colour.
function sweep(prep: Prep): void {
    const kind = KINDS[prep.boardKind.value];
    prep.inPot.value = Math.min(POT.slots, prep.before.value + prep.swept.value);
    prep.before.value = prep.inPot.value;
    for (let k = 0; k < prep.chops.value; k++) {
        const slot = prep.before.value + k;
        if (slot < POT.slots) prep.slotKinds.array[slot] = prep.boardKind.value;
    }
    prep.swept.value = prep.chops.value;
    prep.sweptKind.value = prep.boardKind.value;
    prep.sweptAt = prep.clock;
    prep.lastSeed.value = prep.seed.value;
    prep.boardKind.value = -1;
    prep.chops.value = 0;
    prep.choppedAt = -1e6;
    // Each sweep pulls the stock a step toward the colour of what went in.
    const tint = new THREE.Vector3(...VEG[kind].tint);
    prep.stock.value.lerp(tint, Math.min(0.35, prep.swept.value * 0.018));
    prep.sound?.sweep(prep.swept.value);
}

export function unlockPrep(prep: Prep): void {
    prep.sound ??= initSound();
}

function showPrompt(prompt: Prep['prompt'], use: string | null, replace: string | null): void {
    const showing = `${use}|${replace}`;
    if (prompt.showing === showing) return;
    prompt.showing = showing;
    prompt.box.classList.toggle('shown', use !== null || replace !== null);
    prompt.use.textContent = use ?? '';
    (prompt.use.parentElement as HTMLElement).hidden = use === null;
    prompt.replace.textContent = replace ?? '';
    (prompt.replace.parentElement as HTMLElement).hidden = replace === null;
}

// The turn whose x and y run along `x` and `y` (at right angles); one that takes y to `dir`; one about y by twice
// `half`.
const basis = (x: TslNode, y: TslNode): TslNode => GpuSplatMath.basisToQuat(TSL.mat3(x, y, TSL.cross(x, y)));
const alignY = (dir: TslNode): TslNode => normalize(vec4(TSL.cross(up, dir), dir.y.add(1.0001)));
const yaw = (half: TslNode | number): TslNode => vec4(0, sin(half), 0, cos(half));
// Lit by `light`, never quite black on the side away from it.
const shaded = (colour: TslNode, normal: TslNode, ambient = 0.62): TslNode =>
    colour.mul(
        dot(normal, light)
            .max(0)
            .mul(1 - ambient)
            .add(ambient),
    );
// `values[kind]` for a kind held as a float (0 carrot, 1 onion, 2 celery).
function byKind(kind: TslNode, values: (number | readonly number[])[]): TslNode {
    const node = (v: number | readonly number[]) => (typeof v === 'number' ? float(v) : vec3(v[0], v[1], v[2]));
    return kind.lessThan(0.5).select(node(values[0]), kind.lessThan(1.5).select(node(values[1]), node(values[2])));
}
const veg = <K extends keyof (typeof VEG)['carrot']>(kind: TslNode, key: K): TslNode =>
    byKind(
        kind,
        KINDS.map((k) => VEG[k][key] as number | readonly number[]),
    );

/* shadows */

// Soft dark pools where the board, the pot and the basket meet their tops, so they sit on them rather than float.
function shadows(): SplatObject {
    const under = 28;
    const ring = 24;
    return SplatCollection.object({
        count: under + ring * 2,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const row = TSL.floor(i.div(7));
                const a = i
                    .sub(row.mul(7))
                    .add(0.5)
                    .div(7)
                    .sub(0.5)
                    .mul(BOARD.length * 0.95);
                const b = row
                    .add(0.5)
                    .div(4)
                    .sub(0.5)
                    .mul(BOARD.width * 0.9);
                const boardAt = onBoard(a, b, -BOARD.thickness + 0.0015);
                const k = i.sub(under);
                const angle = k
                    .mod(ring)
                    .div(ring)
                    .mul(Math.PI * 2);
                const isPot = k.lessThan(ring);
                const potAt = vec3(...POT.centre)
                    .add(vec3(cos(angle), 0, sin(angle)).mul(POT.radius * 0.75))
                    .add(vec3(0, 0.0015, 0));
                const ba = new THREE.Vector3(...BASKET.centre);
                const basketAt = vec3(ba.x, ba.y + 0.0015, ba.z)
                    .add(vec3(BASKET_ALONG.x, 0, BASKET_ALONG.z).mul(cos(angle).mul(BASKET.length * 0.38)))
                    .add(vec3(BASKET_OUT.x, 0, BASKET_OUT.z).mul(sin(angle).mul(BASKET.width * 0.38)));
                const isBoard = i.lessThan(under);
                const at = isBoard.select(boardAt, isPot.select(potAt, basketAt));
                const size = isBoard.select(
                    vec3(BOARD.length / 7, 0.0005, BOARD.width / 4),
                    isPot.select(vec3(0.03, 0.0005, 0.03), vec3(0.045, 0.0005, 0.045)),
                );
                return GpuSplats.Splat(at, size, yaw(TURN / 2), vec3(0.02, 0.015, 0.01), float(0.3), uint(index));
            },
        },
    });
}

/* the board */

// Signed distance from the board's rounded outline, metres: negative inside.
function outline(a: TslNode, b: TslNode): TslNode {
    const ha = BOARD.length / 2 - BOARD.corner;
    const hb = BOARD.width / 2 - BOARD.corner;
    const qa = a.abs().sub(ha);
    const qb = b.abs().sub(hb);
    return TSL.length(vec2(max(qa, 0), max(qb, 0)))
        .add(min(max(qa, qb), 0))
        .sub(BOARD.corner);
}

// How far along the board its outline, brought in by `inset`, reaches at `b` toward you.
function reachAt(b: TslNode, inset: number): TslNode {
    const ha = BOARD.length / 2 - BOARD.corner;
    const hb = BOARD.width / 2 - BOARD.corner;
    const r = BOARD.corner - inset;
    const into = max(b.abs().sub(hb), 0);
    return float(r * r)
        .sub(into.mul(into))
        .max(0)
        .sqrt()
        .add(ha);
}

// Glued up from strips, each its own tone, with a fine seam between; grain lines running its length, wavering;
// worn a little in the middle, with faint knife scores there.
function woodAt(a: TslNode, b: TslNode): TslNode {
    const across = b.add(BOARD.width / 2).div(BOARD.width / BOARD.strips);
    const strip = TSL.floor(across);
    const tone = hash(strip.add(4.7)).sub(0.5).mul(0.1);
    const seam = smoothstep(0.03, 0, fract(across).sub(0.5).abs().sub(0.5).abs());
    const waver = mx_noise_float(vec3(a.mul(3), strip, 2)).mul(0.01);
    const grain = pow(
        fract(
            b
                .add(waver)
                .mul(34)
                .add(mx_noise_float(vec3(a.mul(1.4), b.mul(9), 5)).mul(1.3)),
        ),
        4,
    );
    const figure = mx_noise_float(vec3(a.mul(6), b.mul(25), 7))
        .mul(0.5)
        .add(0.5);
    // Worn paler where the knife works, darker stains soaked in here and there, grime toward the edges.
    const worn = smoothstep(0.17, 0.03, TSL.length(vec2(a.mul(0.7), b)));
    const stains = smoothstep(0.35, 0.7, mx_noise_float(vec3(a.mul(9), b.mul(9), 11)))
        .mul(0.5)
        .add(smoothstep(0.55, 0.8, mx_noise_float(vec3(a.mul(24), b.mul(24), 13))).mul(0.35));
    const grime = smoothstep(-0.03, 0, outline(a, b)).mul(0.5);
    const wood = mix(vec3(...BOARD.wood), vec3(...BOARD.grain), grain.mul(0.35).add(figure.mul(0.2)))
        .mul(float(1).add(tone))
        .mul(float(1).sub(seam.mul(0.25)))
        .mul(float(1).add(worn.mul(0.07)))
        .mul(float(1).sub(grime.mul(0.35)));
    return mix(wood, vec3(...BOARD.stain), stains.mul(0.55));
}

// The board's wear, each mark its own thin splats so it stays a mark: knife scratches, short straight cuts at all
// angles but mostly across the grain, in a run of hairline splats each; a split opening along one seam, wandering a
// little and narrowing to nothing; a few herb crumbs.
function boardMarks(): SplatObject {
    const scratches = BOARD.scratches * BOARD.scratchRun;
    const split = BOARD.split;
    return SplatCollection.object({
        count: scratches + split + BOARD.crumbs,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const isScratch = i.lessThan(scratches);
                const isSplit = i.greaterThanEqual(scratches).and(i.lessThan(scratches + split));

                // A scratch: middle, angle and length of its own; this splat's place along it.
                const n = TSL.floor(i.div(BOARD.scratchRun));
                const r = vec4(hash(n.mul(1.13)), hash(n.mul(2.31)), hash(n.mul(3.77)), hash(n.mul(5.03)));
                // Bunched toward the middle, where the knife works.
                const middle = vec2(
                    r.x
                        .sub(0.5)
                        .mul(BOARD.length - 0.05)
                        .mul(r.x.sub(0.5).abs().mul(0.8).add(0.6)),
                    r.y
                        .sub(0.5)
                        .mul(BOARD.width - 0.05)
                        .mul(r.y.sub(0.5).abs().mul(0.8).add(0.6)),
                );
                const angle = r.z.lessThan(0.75).select(
                    r.w
                        .sub(0.5)
                        .mul(1.2)
                        .add(Math.PI / 2),
                    r.w.mul(Math.PI),
                );
                const run = vec2(cos(angle), sin(angle));
                const length = mix(0.012, 0.06, pow(hash(n.mul(7.7)), 1.5));
                const f = i.sub(n.mul(BOARD.scratchRun)).add(0.5).div(BOARD.scratchRun).sub(0.5);
                const scratchAt = middle.add(run.mul(f.mul(length)));
                const fade = float(1).sub(f.abs().mul(2).pow(3));
                const deep = mix(0.25, 0.7, hash(n.mul(9.1)));

                // The split: along the seam between the second and third strips, from one end part way along.
                const g = i.sub(scratches).add(0.5).div(split);
                const seamB = float(BOARD.width / BOARD.strips - BOARD.width / 2 + BOARD.width / BOARD.strips);
                const splitAt = vec2(
                    mix(-BOARD.length / 2 + 0.01, -BOARD.length * 0.05, g),
                    seamB.add(mx_noise_float(vec3(g.mul(6), 0, 3)).mul(0.002)),
                );
                const gap = float(1).sub(g).mul(0.0009).add(0.0002);

                // A crumb: a small green fleck somewhere on it.
                const c = i.sub(scratches + split);
                const crumbAt = vec2(
                    hash(c.mul(3.3))
                        .sub(0.5)
                        .mul(BOARD.length * 0.75),
                    hash(c.mul(4.7))
                        .sub(0.5)
                        .mul(BOARD.width * 0.7),
                );

                const where = isScratch.select(scratchAt, isSplit.select(splitAt, crumbAt));
                const dir = isScratch.select(run, isSplit.select(vec2(1, 0), vec2(cos(c.mul(2.1)), sin(c.mul(2.1)))));
                const along3 = normalize(along.mul(dir.x).add(toward.mul(dir.y)));
                const lift = isScratch.or(isSplit).select(float(0.0003), float(0.0012));
                const centre = onBoard(where.x, where.y, lift);
                const scales = isScratch.select(
                    vec3(length.div(BOARD.scratchRun).mul(0.6), 0.0001, mix(0.0002, 0.00045, deep)),
                    isSplit.select(
                        vec3(
                            float(BOARD.length * 0.45)
                                .div(split)
                                .mul(0.7),
                            0.0001,
                            gap,
                        ),
                        vec3(mix(0.0012, 0.003, hash(c.mul(6.1))), 0.0006, mix(0.0008, 0.0016, hash(c.mul(8.3)))),
                    ),
                );
                const colour = isScratch.select(
                    vec3(...BOARD.scratch).mul(mix(0.9, 1.05, deep)),
                    isSplit.select(vec3(0.12, 0.09, 0.07), vec3(0.2, 0.3, 0.1).mul(hash(c.mul(1.9)).mul(0.5).add(0.7))),
                );
                const opacity = isScratch.select(fade.mul(deep), float(0.9));
                return GpuSplats.Splat(centre, scales, basis(along3, up), shaded(colour, up), opacity, uint(index));
            },
        },
    });
}

// The top inside the rim is grain rows, long splats end to end, each row's fade running only into the rim. The rim
// rounds over in rings that follow the outline, the outermost a hairline; then the side goes down in bands to a dark
// line on the table.
function board(): SplatObject {
    const top = BOARD.rows * BOARD.runs;
    const rim = BOARD.rings * BOARD.around;
    const side = BOARD.bands * BOARD.around;
    const inner = BOARD.width - 2 * BOARD.rim;
    const rowWidth = inner / BOARD.rows;
    const perimeter = 2 * (BOARD.length + BOARD.width) - (8 - 2 * Math.PI) * BOARD.corner;
    const pace = perimeter / BOARD.around;
    const drop = BOARD.thickness - 0.005;
    return SplatCollection.object({
        count: top + rim + side + BOARD.around,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const isTop = i.lessThan(top);

                // A grain row: its place toward you, and the run of splats along it inside the rim.
                const row = TSL.floor(i.div(BOARD.runs));
                const b = row
                    .add(0.5)
                    .mul(rowWidth)
                    .sub(inner / 2);
                const reach = reachAt(b, BOARD.rim);
                const run = reach.mul(2 / BOARD.runs);
                // Each row's runs start at their own offset, and each splat sits somewhere in its cell: no lattice.
                const slip = hash(row.mul(1.9))
                    .sub(0.5)
                    .add(hash(i.mul(2.3)).sub(0.5).mul(0.6));
                const a = i.sub(row.mul(BOARD.runs)).add(0.5).add(slip).mul(run).sub(reach).clamp(reach.negate(), reach);
                const edge = outline(a, b);
                const inGroove = smoothstep(BOARD.groove[1], 0, edge.add(BOARD.groove[0]).abs());
                const topAt = onBoard(a, b, inGroove.mul(-0.0012));
                const topColour = shaded(
                    woodAt(a, b)
                        .mul(float(1).sub(inGroove.mul(0.25)))
                        .mul(hash(row.add(0.37)).mul(0.06).add(0.97)),
                    up,
                );
                const topScales = vec3(run.mul(0.75), 0.0003, rowWidth * 0.85);

                // Round the outline: rings over the rim, bands down the side, the line on the table.
                const k = i.sub(top);
                const loop = TSL.floor(k.div(BOARD.around));
                const t = k.sub(loop.mul(BOARD.around)).add(0.5).div(BOARD.around);
                const { point, normal } = outlinePoint(t);
                const outward = along.mul(normal.x).add(toward.mul(normal.y));
                const tangent = along.mul(normal.y.negate()).add(toward.mul(normal.x));
                const isRim = loop.lessThan(BOARD.rings);
                const isFoot = loop.greaterThanEqual(BOARD.rings + BOARD.bands);
                // The rim: in from the edge, and how far over it's rounded (1 at the very edge).
                const inset = float(BOARD.rings).sub(loop).sub(0.5).div(BOARD.rings).mul(BOARD.rim);
                const over = float(1).sub(inset.div(BOARD.rim));
                const rimAt = onBoard(point.x, point.y, over.mul(over).mul(-0.005)).sub(outward.mul(inset));
                const rimNormal = normalize(up.add(outward.mul(over.mul(1.4))));
                // The side: bands from just under the rim to the table.
                const band = loop.sub(BOARD.rings).add(0.5).div(BOARD.bands);
                const sideAt = onBoard(
                    point.x,
                    point.y,
                    isFoot.select(float(-BOARD.thickness + 0.0008), band.mul(-drop).sub(0.005)),
                );
                const endGrain = smoothstep(0.6, 0.9, normal.x.abs());
                const wood = woodAt(point.x, point.y);
                const sideWood = mix(wood, vec3(...BOARD.grain).mul(0.85), endGrain.mul(0.5));
                const loopColour = isRim.select(
                    shaded(wood.mul(1.05), rimNormal),
                    isFoot.select(vec3(0.05, 0.035, 0.03), shaded(sideWood, outward)),
                );
                const loopAt = isRim.select(rimAt, sideAt);
                const loopScales = vec3(
                    pace * 0.8,
                    0.0003,
                    isRim.select(
                        over.greaterThan(0.85).select(float(0.0007), float((BOARD.rim / BOARD.rings) * 0.8)),
                        isFoot.select(float(0.0008), float((drop / BOARD.bands) * 0.8)),
                    ),
                );
                const loopTurn = basis(tangent, isRim.select(rimNormal, outward));

                return GpuSplats.Splat(
                    isTop.select(topAt, loopAt),
                    isTop.select(topScales, loopScales),
                    isTop.select(yaw(TURN / 2), loopTurn),
                    isTop.select(topColour, loopColour),
                    // Soft, so neighbours melt together; only the hairlines (the rim's very edge, the foot) crisp.
                    isTop.select(float(0.95), isFoot.or(isRim.and(over.greaterThan(0.85))).select(float(CRISP), float(0.95))),
                    uint(index),
                );
            },
        },
        params: { lodInflate: false },
    });
}

// The point `t` (0..1) of the way round the board's rounded outline, in board terms (along, toward), and its outward
// normal there: four straight edges and four quarter-circle corners, walked by length.
function outlinePoint(t: TslNode): { point: TslNode; normal: TslNode } {
    const ha = BOARD.length / 2 - BOARD.corner;
    const hb = BOARD.width / 2 - BOARD.corner;
    const r = BOARD.corner;
    const arc = (Math.PI / 2) * r;
    // Each piece: its length, and the point and normal `f` (0..1) of the way along it.
    const pieces: { length: number; at: (f: TslNode) => { point: TslNode; normal: TslNode } }[] = [];
    const corners = [
        [ha, -hb],
        [ha, hb],
        [-ha, hb],
        [-ha, -hb],
    ];
    const straights = [
        { from: [-ha, -hb - r], to: [ha, -hb - r], normal: [0, -1] },
        { from: [ha + r, -hb], to: [ha + r, hb], normal: [1, 0] },
        { from: [ha, hb + r], to: [-ha, hb + r], normal: [0, 1] },
        { from: [-ha - r, hb], to: [-ha - r, -hb], normal: [-1, 0] },
    ];
    for (let k = 0; k < 4; k++) {
        const line = straights[k];
        pieces.push({
            length: Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]),
            at: (f) => ({ point: mix(vec2(...line.from), vec2(...line.to), f), normal: vec2(...line.normal) }),
        });
        const [ca, cb] = corners[k];
        const start = -Math.PI / 2 + (k * Math.PI) / 2;
        pieces.push({
            length: arc,
            at: (f) => {
                const angle = f.mul(Math.PI / 2).add(start);
                const normal = vec2(cos(angle), sin(angle));
                return { point: vec2(ca, cb).add(normal.mul(r)), normal };
            },
        });
    }
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const d = t.mul(total);
    let point: TslNode = vec2(0);
    let normal: TslNode = vec2(0);
    let walked = 0;
    for (const piece of pieces) {
        const here = piece.at(d.sub(walked).div(piece.length).clamp(0, 1));
        const past = d.greaterThanEqual(walked);
        point = past.select(here.point, point);
        normal = past.select(here.normal, normal);
        walked += piece.length;
    }
    return { point, normal };
}

/* the vegetables */

// A vegetable's radius `s` of the way from its top (0) to its end (1): a carrot tapering to its tip, an onion round
// with a point at each end, a celery stalk a little wider toward its base.
function radiusAt(s: TslNode, kind: TslNode): TslNode {
    const carrot = float(VEG.carrot.radius)
        .mul(pow(float(1).sub(s).max(0), 0.55))
        .mul(mix(0.82, 1, smoothstep(0, 0.07, s)));
    const onion = float(VEG.onion.radius).mul(pow(sin(s.clamp(0.005, 0.995).mul(Math.PI)), 0.62));
    const celery = float(VEG.celery.radius)
        .mul(mix(0.9, 1.12, s))
        .mul(smoothstep(0, 0.02, s).mul(0.3).add(0.7));
    return kind.lessThan(0.5).select(carrot, kind.lessThan(1.5).select(onion, celery));
}
const lengthOf = (kind: TslNode): TslNode => veg(kind, 'length');
// Where the knife has cut to (as `s`): everything past it has been sliced off.
const cutAt = (chops: TslNode, kind: TslNode): TslNode => float(1).sub(chops.mul(SLICE).div(lengthOf(kind)));
// How many slices are off: a chop only counts once the blade's through.
const severed = (chops: TslNode, _sinceChop: TslNode): TslNode => chops;

// Splat `k` of a vegetable of `kind` on the axis from `stem` along `dir`. Its skin soft splats in rings, each nudged
// in its own cell; its marks runs of thin splats round it or along it; its top. The shape bent a little (`bend`
// metres at its middle) and lumpy; celery's section flattened and grooved on top.
function vegSplat(k: TslNode, kind: TslNode, stem: TslNode, dir: TslNode, seed: TslNode, bend: TslNode | number) {
    const isSkin = k.lessThan(SKIN_SPLATS);
    const isMark = k.greaterThanEqual(SKIN_SPLATS).and(k.lessThan(SKIN_SPLATS + MARKS));
    const isPore = k.greaterThanEqual(SKIN_SPLATS + MARKS).and(k.lessThan(SKIN_SPLATS + MARKS + SKIN.pores));
    const isTop = k.greaterThanEqual(SKIN_SPLATS + MARKS + SKIN.pores);
    const jitter = vec3(hash(k.mul(1.37).add(seed)), hash(k.mul(2.71).add(seed)), hash(k.mul(3.97).add(seed)));
    const length = lengthOf(kind);
    const marksAlong = veg(kind, 'marksAlong').greaterThan(0.5);

    // The skin: ring and slot, each splat somewhere in its own cell.
    const ring = TSL.floor(k.div(SKIN.around));
    const skinS = ring.add(0.5).add(jitter.x.sub(0.5).mul(0.8)).div(SKIN.rings).clamp(0, 1);
    const skinAngle = k
        .sub(ring.mul(SKIN.around))
        .add(0.5)
        .add(jitter.y.sub(0.5).mul(0.8))
        .add(ring.mul(0.37))
        .div(SKIN.around)
        .mul(Math.PI * 2);
    // A mark: round it at an uneven step along, part way round; or along it, from near one end to near the other.
    const c = k.sub(SKIN_SPLATS);
    const mark = TSL.floor(c.div(SKIN.markRun));
    const f = c.sub(mark.mul(SKIN.markRun)).add(0.5).div(SKIN.markRun);
    const arc = mix(0.25, 0.6, hash(mark.mul(5.3).add(seed))).mul(Math.PI * 2);
    const roundS = mark
        .add(0.5)
        .add(hash(mark.add(seed)).sub(0.5).mul(0.8))
        .div(SKIN.marks);
    const roundAngle = hash(mark.mul(3.1).add(seed))
        .mul(Math.PI * 2)
        .add(f.mul(arc));
    const alongS = mix(0.06, 0.94, f);
    const alongAngle = mark
        .add(hash(mark.mul(3.1).add(seed)).mul(0.6))
        .div(SKIN.marks)
        .mul(Math.PI * 2);
    // A pore: anywhere but the very ends.
    const pore = k.sub(SKIN_SPLATS + MARKS);
    const poreS = hash(pore.mul(7.1).add(seed)).mul(0.85).add(0.07);
    const poreAngle = hash(pore.mul(9.3).add(seed)).mul(Math.PI * 2);

    const s = isSkin.select(skinS, isMark.select(marksAlong.select(alongS, roundS), poreS)).toVar();
    const angle = isSkin.select(skinAngle, isMark.select(marksAlong.select(alongAngle, roundAngle), poreAngle));
    const side = normalize(TSL.cross(up, dir));
    const over = TSL.cross(dir, side);
    const round = side.mul(cos(angle)).add(over.mul(sin(angle)));
    const lumps = float(1)
        .add(mx_noise_float(vec3(s.mul(7), seed, 1)).mul(0.07))
        .add(mx_noise_float(vec3(s.mul(22), angle.mul(0.8), seed)).mul(0.03));
    const groove = kind.greaterThan(1.5).select(float(1).sub(max(sin(angle), 0).mul(0.3)), float(1));
    const r = radiusAt(s, kind).mul(lumps).mul(groove);
    const raised = isSkin.select(float(0), float(0.00025));
    const centre = stem
        .add(dir.mul(s.mul(length)))
        .add(side.mul(sin(s.mul(Math.PI)).mul(bend)))
        .add(round.mul(r.add(raised)));

    // The skin's colour, a smooth field, top to end; marks and pores darker or lighter.
    const base = mix(
        mix(veg(kind, 'top'), veg(kind, 'skin'), smoothstep(0.02, 0.14, s)),
        veg(kind, 'end'),
        smoothstep(0.55, 1, s),
    ).mul(
        mx_noise_float(vec3(s.mul(5), angle.mul(0.5), seed.add(9)))
            .mul(0.07)
            .add(1),
    );
    const sheen = pow(dot(round, normalize(light.add(up))).max(0), 24).mul(0.1);
    const tone = isSkin.select(float(1), isMark.select(veg(kind, 'marks'), float(0.6)));
    const colour = shaded(base.mul(tone), round, 0.55).add(sheen.mul(tone));

    // Skin splats as big as their cell and a bit, so they overlap; marks and pores hairline thin.
    const cellAlong = length.div(SKIN.rings);
    const cellRound = max(r.mul((Math.PI * 2) / SKIN.around), 0.0008);
    const vary = jitter.z.mul(0.3).add(0.85);
    const markScales = marksAlong.select(
        vec3(length.mul(0.88 / SKIN.markRun), 0.0002, 0.0007),
        vec3(0.0008, 0.0002, arc.mul(r).div(SKIN.markRun).mul(0.9)),
    );
    const scales = isSkin.select(
        vec3(cellAlong.mul(vary), 0.0003, cellRound.mul(0.95).mul(vary)),
        isMark.select(markScales, vec3(0.0004, 0.0002, 0.0014)),
    );
    const twist = isSkin.select(jitter.z.sub(0.5).mul(0.3), float(0));
    const lengthwise = normalize(dir.add(TSL.cross(round, dir).mul(twist)));
    const fade = smoothstep(0, 0.15, f).mul(smoothstep(1, 0.85, f));
    const opacity = isSkin.select(
        float(0.95),
        isMark.select(fade.mul(0.75), isPore.select(float(0.6).mul(kind.lessThan(0.5).select(float(1), float(0))), float(0))),
    );

    const top = topSplat(k.sub(SKIN_SPLATS + MARKS + SKIN.pores), kind, stem, dir, side, over, seed);
    return {
        s,
        isTop,
        centre: isTop.select(top.centre, centre),
        quaternion: isTop.select(top.quaternion, basis(lengthwise, round)),
        scales: isTop.select(top.scales, scales),
        colour: isTop.select(top.colour, colour),
        opacity: isTop.select(top.opacity, opacity),
    };
}

// One piece of a vegetable's top, off its top end: a carrot's stalks cut almost flush, an onion's dry papery neck,
// celery's leaves fanning out.
function topSplat(t: TslNode, kind: TslNode, stem: TslNode, dir: TslNode, side: TslNode, over: TslNode, seed: TslNode) {
    const count = veg(kind, 'tops');
    const around = t
        .div(count)
        .mul(Math.PI * 2)
        .add(seed);
    const out = side.mul(cos(around)).add(over.mul(sin(around)));
    const isLeaf = kind.greaterThan(1.5);
    // Celery's leaves fan up and out in a spray; the others lean straight back.
    const spray = t.sub(count.sub(1).mul(0.5)).div(count).mul(1.6);
    const leafOut = side.mul(sin(spray)).add(over.mul(cos(spray).mul(0.6)));
    const lean = normalize(dir.negate().add(isLeaf.select(leafOut, out).mul(veg(kind, 'topSpread'))));
    const range = byKind(
        kind,
        KINDS.map((k) => VEG[k].topLength[0]),
    );
    const reach = byKind(
        kind,
        KINDS.map((k) => VEG[k].topLength[1]),
    );
    const length = mix(range, reach, hash(t.add(seed)));
    const width = veg(kind, 'topWidth');
    return {
        centre: stem.add(out.mul(isLeaf.select(float(0.002), float(0.0035)))).add(lean.mul(length)),
        quaternion: alignY(lean),
        scales: vec3(width, length, isLeaf.select(float(0.0006), width)),
        colour: shaded(veg(kind, 'topColour').mul(hash(t.add(seed).mul(2.2)).mul(0.25).add(0.85)), up, 0.6),
        opacity: step(t.add(0.5), count).mul(0.95),
    };
}

// A cut face: soft splats in rings, the middle paler; the rings an onion's layers show (or the faint one between a
// carrot's core and flesh) each a run of thin splats; a crisp ring of flesh and a hairline of skin closing the edge.
// A slice is a short cylinder: a face each end and a band of skin round it, its outline not quite round.
// Ring splats: enough that an onion's every layer is a smooth circle of short pieces, not a few long straight
// dashes (which, offset ring to ring, swirl like a turbine).
const FACE = { rings: 7, around: 28, ring: 240, rim: 64 };
const FACE_FILL = FACE.rings * FACE.around;
const FACE_SPLATS = FACE_FILL + FACE.ring + FACE.rim * 2;
const SLICE_SIDE = { rows: 3, around: 18 };
const PER_SLICE = FACE_SPLATS * 2 + SLICE_SIDE.rows * SLICE_SIDE.around;

// Two directions across the plane facing `n`.
function across2(n: TslNode): { u: TslNode; v: TslNode } {
    const helper = n.y.abs().lessThan(0.9).select(up, along);
    const u = normalize(TSL.cross(helper, n));
    return { u, v: TSL.cross(n, u) };
}

// A slice's outline, `angle` round it: not quite round.
const sliceEdge = (angle: TslNode, seed: TslNode): TslNode =>
    float(1)
        .add(sin(angle.mul(3).add(seed)).mul(0.035))
        .add(sin(angle.mul(5).add(seed.mul(1.7))).mul(0.02));

function faceSplat(k: TslNode, kind: TslNode, centre: TslNode, n: TslNode, radius: TslNode, seed: TslNode) {
    const { u, v } = across2(n);
    const isFill = k.lessThan(FACE_FILL);
    const isRing = k.greaterThanEqual(FACE_FILL).and(k.lessThan(FACE_FILL + FACE.ring));
    const e = k.sub(FACE_FILL + FACE.ring);
    const isFlesh = e.greaterThanEqual(0).and(e.lessThan(FACE.rim));
    const isSkin = e.greaterThanEqual(FACE.rim);
    const row = TSL.floor(k.div(FACE.around));
    const j = vec3(hash(k.mul(1.3).add(seed)), hash(k.mul(2.9).add(seed)), hash(k.mul(4.1).add(seed)));
    const spacing = 0.79 / (FACE.rings - 1);
    const fillOut = mix(0.06, 0.85, row.add(j.x.sub(0.5).mul(0.25)).div(FACE.rings - 1));
    const fillAngle = k
        .sub(row.mul(FACE.around))
        .add(0.5)
        .add(hash(row.add(seed)))
        .add(j.y.sub(0.5).mul(0.4))
        .div(FACE.around)
        .mul(Math.PI * 2);
    // The ring splats: shared between however many rings this kind shows.
    const rings = veg(kind, 'rings').max(1);
    const q = k.sub(FACE_FILL);
    const perRing = TSL.floor(float(FACE.ring).div(rings));
    const ringIndex = TSL.floor(q.div(perRing)).min(rings.sub(1));
    const ringAngle = q
        .sub(ringIndex.mul(perRing))
        .add(0.5)
        .add(hash(ringIndex.add(seed)))
        .div(perRing)
        .mul(Math.PI * 2);
    const ringOut = rings.greaterThan(1.5).select(ringIndex.add(1).div(rings.add(1)), float(0.5));
    const rimAngle = e
        .mod(FACE.rim)
        .add(0.5)
        .div(FACE.rim)
        .mul(Math.PI * 2);
    const out = isFill.select(fillOut, isRing.select(ringOut, isFlesh.select(float(0.93), float(0.99))));
    const angle = isFill.select(fillAngle, isRing.select(ringAngle, rimAngle));
    const radial = u.mul(cos(angle)).add(v.mul(sin(angle)));
    const r = out.mul(radius).mul(sliceEdge(angle, seed));
    const at = centre.add(radial.mul(r)).add(n.mul(isRing.or(isSkin).select(float(0.0002), float(0))));
    // Inside: middle to outer, with a carrot's faint streaks out from its core.
    const from = byKind(kind, [0.42, 0.1, 0.3]);
    const to = byKind(kind, [0.58, 0.3, 0.9]);
    const streaks = sin(angle.mul(13).add(seed))
        .mul(0.04)
        .mul(smoothstep(0.5, 0.1, out))
        .mul(kind.lessThan(0.5).select(float(1), float(0)));
    const inside = mix(veg(kind, 'core'), veg(kind, 'flesh'), smoothstep(from, to, out)).mul(float(1).add(streaks));
    const ringColour = veg(kind, 'flesh').mul(kind.lessThan(0.5).select(float(0.85), float(0.82)));
    // An onion's papery skin barely shows at a slice's edge: a thin golden line, not a brown band.
    const edge = byKind(kind, [VEG.carrot.skin.map((c) => c * 0.8), [0.82, 0.72, 0.5], VEG.celery.skin.map((c) => c * 0.8)]);
    const base = isSkin.select(edge, isRing.select(ringColour, inside));
    const colour = shaded(base, n, 0.7);
    const aroundOf = (count: TslNode | number) =>
        radius
            .mul(out)
            .mul(Math.PI * 2 * 0.9)
            .div(count);
    const scales = isFill.select(
        vec3(
            radius
                .mul(spacing * 1.05)
                .mul(float(1).sub(out.mul(out).mul(0.5)))
                .mul(kind.greaterThan(0.5).and(kind.lessThan(1.5)).select(float(0.7), float(1))),
            0.0002,
            max(aroundOf(FACE.around).mul(1.1), radius.mul(spacing * 0.8)),
        ),
        isRing.select(
            vec3(0.00035, 0.0002, aroundOf(perRing).mul(0.75)),
            // Crisp, so kept short along the edge: long straight pieces would stick out past its curve like a star.
            vec3(isFlesh.select(radius.mul(0.03), float(0.0004)), 0.0002, aroundOf(FACE.rim).mul(0.55)),
        ),
    );
    // Celery shows no rings; a carrot's is faint; an onion's layers clear.
    const ringOpacity = byKind(kind, [0.08, 0.45, 0]);
    const opacity = isFill.select(float(0.95), isRing.select(ringOpacity, float(CRISP)));
    return { centre: at, quaternion: basis(radial, n), scales, colour, opacity };
}

// Splat `k` of a slice of `kind`, `radius` across, centred at `centre` and facing `n`.
function sliceSplat(k: TslNode, kind: TslNode, centre: TslNode, n: TslNode, radius: TslNode, seed: TslNode) {
    const isTop = k.lessThan(FACE_SPLATS);
    const isBottom = k.greaterThanEqual(FACE_SPLATS).and(k.lessThan(FACE_SPLATS * 2));
    const face = faceSplat(
        isTop.select(k, k.sub(FACE_SPLATS)),
        kind,
        centre.add(n.mul(isTop.select(float(SLICE / 2), float(-SLICE / 2)))),
        isTop.select(n, n.negate()),
        radius,
        seed,
    );
    // The side: rows of skin round it.
    const { u, v } = across2(n);
    const sk = k.sub(FACE_SPLATS * 2);
    const row = TSL.floor(sk.div(SLICE_SIDE.around));
    const angle = sk
        .sub(row.mul(SLICE_SIDE.around))
        .add(0.5)
        .add(hash(row.add(seed)))
        .div(SLICE_SIDE.around)
        .mul(Math.PI * 2);
    const radial = u.mul(cos(angle)).add(v.mul(sin(angle)));
    const sideAt = centre
        .add(n.mul(row.add(0.5).div(SLICE_SIDE.rows).sub(0.5).mul(SLICE)))
        .add(radial.mul(radius.mul(sliceEdge(angle, seed))));
    const side = byKind(kind, [VEG.carrot.skin, [0.86, 0.82, 0.7], VEG.celery.skin]);
    const sideColour = shaded(side.mul(hash(sk.add(seed)).mul(0.08).add(0.95)), radial, 0.55);
    const sideScales = vec3((SLICE / SLICE_SIDE.rows) * 0.85, 0.0002, radius.mul((Math.PI * 2 * 0.85) / SLICE_SIDE.around));
    const isFace = isTop.or(isBottom);
    return {
        centre: isFace.select(face.centre, sideAt),
        quaternion: isFace.select(face.quaternion, basis(n, radial)),
        scales: isFace.select(face.scales, sideScales),
        colour: isFace.select(face.colour, sideColour),
        opacity: isFace.select(face.opacity, float(0.95)),
    };
}

/* on the board */

// A toss into the pot, `t` from 0 to 1 of its flight: a high parabola, rising well clear of the rim and dropping in.
function intoPot(from: TslNode, to: TslNode, t: TslNode): TslNode {
    const rim = float(POT.centre[1] + POT.height);
    const apex = rim.sub(min(from.y, to.y)).add(SWEEP.apex);
    const flat = mix(from, to, t);
    const y = mix(from.y, to.y, t).add(apex.mul(4).mul(t).mul(float(1).sub(t)));
    return vec3(flat.x, y, flat.z);
}

// Where a vegetable of `kind` lies on the board: a point on its axis, `s` from top to end, its end on the right.
const axisAt = (s: TslNode, kind: TslNode): TslNode =>
    onBoard(
        float(LIES.end)
            .sub(lengthOf(kind))
            .add(s.mul(lengthOf(kind))),
        LIES.back,
        veg(kind, 'radius').mul(kind.lessThan(0.5).select(float(0.92), float(1))),
    );

// What's on the board, chopped down from its end, its cut face showing. Laid down, it drops the last few
// centimetres and settles.
function boardVeg(prep: Prep): SplatObject {
    const { boardKind, chops, sinceChop, sincePlaced, seed } = prep;
    return SplatCollection.object({
        count: PER_VEG + FACE_SPLATS,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const kind = boardKind.max(0);
                const off = severed(chops, sinceChop);
                const cut = cutAt(off, kind);
                const part = vegSplat(i, kind, axisAt(float(0), kind), along, seed, 0);
                const isFace = i.greaterThanEqual(PER_VEG);
                const face = faceSplat(i.sub(PER_VEG), kind, axisAt(cut, kind), along, radiusAt(cut, kind), seed);
                const d = smoothstep(0, SWEEP.place, sincePlaced);
                const after = sincePlaced.sub(SWEEP.place).max(0);
                const drop = float(1)
                    .sub(d)
                    .pow(2)
                    .mul(0.07)
                    .add(
                        TSL.exp(after.mul(-16))
                            .mul(sin(after.mul(30)).abs())
                            .mul(0.003),
                    );
                const shows = step(0, boardKind);
                return GpuSplats.Splat(
                    isFace.select(face.centre, part.centre).add(up.mul(drop)),
                    isFace.select(face.scales, part.scales),
                    isFace.select(face.quaternion, part.quaternion),
                    isFace.select(face.colour, part.colour),
                    isFace
                        .select(
                            face.opacity.mul(step(0.5, off)),
                            part.opacity.mul(part.isTop.select(float(1), step(part.s, cut))),
                        )
                        .mul(shows),
                    uint(index),
                );
            },
        },
        params: { lodInflate: false },
    });
}

// After a sweep, the stub: up and over into the pot after its slices, sinking into the stock as it lands.
function stub(prep: Prep): SplatObject {
    const { sweptKind, swept, sinceSweep, lastSeed, inPot } = prep;
    return SplatCollection.object({
        count: PER_VEG + FACE_SPLATS,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const kind = sweptKind;
                const cut = cutAt(swept, kind);
                const middle = axisAt(cut.mul(0.5), kind);
                const part = vegSplat(i, kind, axisAt(float(0), kind), along, lastSeed, 0);
                const isFace = i.greaterThanEqual(PER_VEG);
                const face = faceSplat(i.sub(PER_VEG), kind, axisAt(cut, kind), along, radiusAt(cut, kind), lastSeed);
                const go = sinceSweep.sub(SWEEP.stub).div(SWEEP.stubFlight).clamp(0, 1);
                const into = vec3(...POT.centre).add(vec3(0, levelAt(inPot), 0));
                const offset = intoPot(middle, into, go).sub(middle);
                const shrink = float(1).sub(smoothstep(0.9, 1, go).mul(0.9));
                const turn = go.mul(Math.PI * 2.5);
                const roll = vec4(along.mul(sin(turn.mul(0.5))), cos(turn.mul(0.5)));
                const place = (p: TslNode) => middle.add(GpuSplatMath.quatRotate(roll, p.sub(middle).mul(shrink))).add(offset);
                const shows = step(0.5, swept).mul(step(go, 0.999));
                return GpuSplats.Splat(
                    place(isFace.select(face.centre, part.centre)),
                    isFace.select(face.scales, part.scales).mul(shrink),
                    GpuSplatMath.quatMul(roll, isFace.select(face.quaternion, part.quaternion)),
                    isFace.select(face.colour, part.colour),
                    isFace.select(face.opacity, part.opacity.mul(part.isTop.select(float(1), step(part.s, cut)))).mul(shows),
                    uint(index),
                );
            },
        },
        params: { lodInflate: false },
    });
}

// The slices on the board: each topples away from the vegetable as the blade goes through, faster as it goes, and
// lands with a little bounce, the first flat and each after it lying on the one before, so they fan out in a row.
// Swept, they fly in an arc into the pot and float there.
function coins(prep: Prep): SplatObject {
    const { boardKind, sweptKind, chops, sinceChop, swept, sinceSweep, before, seed, lastSeed, inPot } = prep;
    return SplatCollection.object({
        count: MAX_CHOPS * PER_SLICE,
        generator: {
            generateSplat(index: TslNode) {
                const coin = TSL.floor(float(index).div(PER_SLICE));
                const off = severed(chops, sinceChop);
                const there = coin.lessThan(off).and(boardKind.greaterThanEqual(0));
                const kind = there.select(boardKind.max(0), sweptKind);
                const own = there.select(seed, lastSeed);
                const r4 = vec4(
                    hash(coin.add(own)),
                    hash(coin.add(own).mul(1.7)),
                    hash(coin.add(own).mul(2.3)),
                    hash(coin.add(own).mul(3.1)),
                );
                // Coin k came off between k and k+1 slices from the end.
                const s = float(1).sub(coin.add(0.5).mul(SLICE).div(lengthOf(kind)));
                const r = radiusAt(s, kind);

                const newest = coin.equal(off.sub(1));
                const t = newest.select(sinceChop.div(COIN.fall), float(1)).clamp(0, 1);
                const propped = coin.greaterThan(0).select(TSL.asin(min(float(SLICE * 1.1).div(r.mul(1.4)), 0.6)), float(0));
                const landed = float(Math.PI / 2)
                    .sub(propped)
                    .add(r4.x.sub(0.5).mul(0.1));
                const after = newest.select(sinceChop.sub(COIN.fall), float(1)).max(0);
                const bounce = TSL.exp(after.mul(-18))
                    .mul(sin(after.mul(28)).abs())
                    .mul(0.12)
                    .mul(step(0.999, t));
                const tip = landed.mul(t.mul(t)).sub(bounce);
                const standing = axisAt(s, kind);
                const pivotAt = standing.sub(up.mul(r)).add(along.mul(SLICE / 2));
                const pivot = vec3(pivotAt.x, mix(pivotAt.y, onBoard(0, 0, 0).y, t), pivotAt.z).add(
                    toward.mul(r4.y.sub(0.5).mul(0.006)),
                );
                const rise = up.mul(cos(tip)).add(along.mul(sin(tip)));
                const restFacing = along.mul(cos(tip)).sub(up.mul(sin(tip)));
                const rest = pivot.add(rise.mul(r)).sub(restFacing.mul(SLICE / 2));

                // Swept: off the board in an arc to its place on the stock.
                const sweeping = coin.lessThan(swept);
                const launch = coin.div(swept.max(1)).mul(SWEEP.spread);
                const go = sinceSweep.sub(launch).div(SWEEP.flight).clamp(0, 1);
                const slot = potSlot(min(before.add(coin), POT.slots - 1), inPot);
                const flying = intoPot(rest, slot.centre, go);
                // Tumbling end over end as it flies, settling flat as it lands.
                const spin = go.mul(Math.PI * 2).mul(r4.z.add(0.8));
                const axis = normalize(TSL.cross(up, slot.centre.sub(rest)).add(vec3(0.0001, 0, 0)));
                const tumbling = restFacing.mul(cos(spin)).add(TSL.cross(axis, restFacing).mul(sin(spin)));
                const flyingFacing = normalize(mix(tumbling, slot.facing, smoothstep(0.75, 1, go)));

                const facing = there.select(restFacing, flyingFacing);
                const shows = there.or(sweeping.and(sinceSweep.lessThan(SWEEP.spread + SWEEP.flight + 0.1)));
                const part = sliceSplat(
                    float(index).sub(coin.mul(PER_SLICE)),
                    kind,
                    there.select(rest, flying),
                    facing,
                    r,
                    coin.add(own),
                );
                return GpuSplats.Splat(
                    part.centre,
                    part.scales,
                    part.quaternion,
                    part.colour.mul(r4.w.mul(0.06).add(0.97)),
                    part.opacity.mul(shows.select(float(1), float(0))),
                    uint(index),
                );
            },
        },
        params: { lodInflate: false },
    });
}

/* the basket */

// A point on the basket's wall, `angle` round its oval and `h` up it, flaring outward toward the top; and the wall's
// outward normal and its tangent there.
function basketWall(angle: TslNode, h: TslNode, inset: TslNode | number) {
    const flare = float(1).add(h.div(BASKET.height).mul(BASKET.flare));
    const a = flare.mul(BASKET.length / 2).sub(inset);
    const b = flare.mul(BASKET.width / 2).sub(inset);
    const bAlong = vec3(BASKET_ALONG.x, 0, BASKET_ALONG.z);
    const bOut = vec3(BASKET_OUT.x, 0, BASKET_OUT.z);
    const at = vec3(...BASKET.centre)
        .add(bAlong.mul(cos(angle).mul(a)))
        .add(bOut.mul(sin(angle).mul(b)))
        .add(vec3(0, h, 0));
    const normal = normalize(
        bAlong
            .mul(cos(angle).div(a))
            .add(bOut.mul(sin(angle).div(b)))
            .add(vec3(0, -BASKET.flare * 0.5, 0)),
    );
    const tangent = normalize(bAlong.mul(sin(angle).negate().mul(a)).add(bOut.mul(cos(angle).mul(b))));
    return { at, normal, tangent };
}

// Willow strands in rows round the wall, outside and in, each going over and under the stakes in turn (bulging
// out and catching the light where it's over, sunk in shadow where it's under, the next row the other way); a rolled
// rim on top; a woven floor.
function basket(): SplatObject {
    const wall = BASKET.rows * BASKET.around;
    const rim = BASKET.rimRings * BASKET.around;
    const floor = BASKET.floor * BASKET.around;
    return SplatCollection.object({
        count: wall * 2 + rim + floor + BASKET.broken,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const isWall = i.lessThan(wall * 2);
                const inside = i.greaterThanEqual(wall).and(isWall);
                const w = i.mod(wall);
                const row = TSL.floor(w.div(BASKET.around));
                const angle = w
                    .sub(row.mul(BASKET.around))
                    .add(0.5)
                    .add(hash(row.mul(2.3)).mul(0.5))
                    .div(BASKET.around)
                    .mul(Math.PI * 2);
                const h = row.add(0.5).div(BASKET.rows).mul(BASKET.height);
                const weave = fract(
                    angle
                        .div(Math.PI * 2)
                        .mul(BASKET.stakes)
                        .add(row.mul(0.5)),
                );
                const bulge = sin(weave.mul(Math.PI));
                const side = basketWall(angle, h, inside.select(float(0.006), float(0)));
                const facing = inside.select(side.normal.negate(), side.normal);
                const wallAt = side.at.add(facing.mul(bulge.mul(0.0018)));
                // Each run of strand between stakes its own tone: most a worn grey-brown, a few bleached pale, a few
                // dark; grime in blotches; dust settled in the dips of the weave and toward the base.
                const run = hash(row.mul(5.1).add(TSL.floor(angle.mul(BASKET.stakes / (Math.PI * 2))).mul(0.37)));
                const willow = mix(
                    mix(vec3(...BASKET.wicker), vec3(...BASKET.bleached), smoothstep(0.75, 0.95, run)),
                    vec3(...BASKET.shade).mul(1.6),
                    smoothstep(0.2, 0.05, run),
                ).mul(run.mul(0.16).add(0.88));
                const grime = smoothstep(0.1, 0.6, mx_noise_float(vec3(angle.mul(3), h.mul(30), 31))).mul(0.35);
                const dusty = float(1)
                    .sub(bulge)
                    .mul(0.5)
                    .add(smoothstep(0.5, 0, h.div(BASKET.height)).mul(0.35));
                const strand = mix(
                    mix(vec3(...BASKET.shade), willow, bulge.mul(0.6).add(0.4)).mul(float(1).sub(grime)),
                    vec3(...BASKET.dust),
                    dusty.mul(0.35),
                );
                const wallColour = shaded(strand.mul(inside.select(float(0.55), float(1))), facing, 0.5);
                const circumference = Math.PI * (BASKET.length + BASKET.width) * 0.5;
                const wallScales = vec3((circumference / BASKET.around) * 0.9, 0.0004, (BASKET.height / BASKET.rows) * 0.42);

                // The rim: a rolled bundle round the top, three strands twisted round it.
                const k = i.sub(wall * 2);
                const isRim = k.greaterThanEqual(0).and(k.lessThan(rim));
                const rr = TSL.floor(k.div(BASKET.around));
                const ra = k
                    .sub(rr.mul(BASKET.around))
                    .add(0.5)
                    .div(BASKET.around)
                    .mul(Math.PI * 2);
                const twist = ra.mul(18).add(rr.mul((Math.PI * 2) / 3));
                const top = basketWall(ra, float(BASKET.height), 0);
                const tube = top.normal.mul(cos(twist)).add(up.mul(sin(twist)));
                const rimAt = top.at.add(up.mul(0.004)).add(tube.mul(0.0065));
                // Darkened and polished by hands, its strands each a shade apart.
                const rimColour = shaded(
                    mix(vec3(...BASKET.wicker), vec3(...BASKET.shade).mul(1.4), 0.45).mul(
                        hash(rr.add(TSL.floor(ra.mul(6))))
                            .mul(0.14)
                            .add(0.93),
                    ),
                    tube,
                    0.5,
                ).add(pow(dot(tube, light).max(0), 12).mul(0.05));

                // The floor: rings in from the wall.
                const fl = k.sub(rim);
                const fr = TSL.floor(fl.div(BASKET.around));
                const fa = fl
                    .sub(fr.mul(BASKET.around))
                    .add(0.5)
                    .add(hash(fr))
                    .div(BASKET.around)
                    .mul(Math.PI * 2);
                const shrink = fr.add(0.5).div(BASKET.floor);
                const fb = basketWall(fa, float(0.006), 0);
                const floorAt = vec3(...BASKET.centre)
                    .add(fb.at.sub(vec3(...BASKET.centre)).mul(vec3(shrink, 1, shrink)))
                    .add(vec3(0, 0.006, 0));
                const floorColour = shaded(mix(vec3(...BASKET.shade).mul(1.1), vec3(...BASKET.dust), 0.3), up, 0.6);

                // A broken end: a short stiff splinter of willow poking out of the weave.
                const e = k.sub(rim + floor);
                const isBroken = e.greaterThanEqual(0);
                const ea = hash(e.mul(3.3)).mul(Math.PI * 2);
                const eh = mix(0.015, BASKET.height * 0.95, hash(e.mul(5.7)));
                const from = basketWall(ea, eh, 0);
                const poke = normalize(
                    from.normal
                        .mul(0.7)
                        .add(up.mul(hash(e.mul(7.9)).mul(0.8)))
                        .add(from.tangent.mul(hash(e.mul(9.1)).sub(0.5).mul(1.2))),
                );
                const stick = mix(0.006, 0.018, hash(e.mul(11.3)));
                const brokenAt = from.at.add(poke.mul(stick.mul(0.5)));
                const brokenColour = shaded(
                    mix(vec3(...BASKET.wicker), vec3(...BASKET.bleached), hash(e.mul(13.7))),
                    from.normal,
                    0.5,
                );

                const centre = isWall.select(wallAt, isRim.select(rimAt, isBroken.select(brokenAt, floorAt)));
                const quaternion = isWall.select(
                    basis(side.tangent, facing),
                    isRim.select(basis(top.tangent, tube), isBroken.select(alignY(poke), basis(fb.tangent, up))),
                );
                const scales = isWall.select(
                    wallScales,
                    isRim.select(
                        vec3((circumference / BASKET.around) * 0.9, 0.0004, 0.0042),
                        isBroken.select(
                            vec3(0.0008, stick.mul(0.5), 0.0008),
                            vec3(
                                float((circumference / BASKET.around) * 0.9)
                                    .mul(shrink)
                                    .max(0.002),
                                0.0004,
                                0.006,
                            ),
                        ),
                    ),
                );
                const colour = isWall.select(wallColour, isRim.select(rimColour, isBroken.select(brokenColour, floorColour)));
                return GpuSplats.Splat(centre, scales, quaternion, colour, float(0.95), uint(index));
            },
        },
    });
}

// The vegetables heaped in the basket.
function basketVeg(): SplatObject {
    return SplatCollection.object({
        count: PER_VEG * BASKET.items.length,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const n = TSL.floor(i.div(PER_VEG));
                let stem: TslNode = vec3(0);
                let dir: TslNode = along;
                let kind: TslNode = float(0);
                for (const [m, item] of BASKET.items.entries()) {
                    const v = VEG[item.kind];
                    // Lying flat along the basket; celery leans its leafy top up and out past the right-hand rim, its
                    // base down in the basket.
                    const flat = BASKET_ALONG.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), item.twist);
                    const pitch = item.pitch ?? 0;
                    const facing = pitch
                        ? flat.multiplyScalar(-Math.cos(pitch)).add(new THREE.Vector3(0, -Math.sin(pitch), 0))
                        : flat;
                    const middle = inBasket(item.at[0], item.at[1], 0.008 + v.radius + item.lift);
                    const from = middle.addScaledVector(facing, -v.length / 2);
                    const here = n.equal(m);
                    stem = here.select(vec3(from.x, from.y, from.z), stem);
                    dir = here.select(vec3(facing.x, facing.y, facing.z), dir);
                    kind = here.select(float(KINDS.indexOf(item.kind)), kind);
                }
                const seed = n.mul(13.1).add(4);
                const part = vegSplat(i.sub(n.mul(PER_VEG)), kind, stem, dir, seed, hash(n.add(7.7)).sub(0.5).mul(0.01));
                return GpuSplats.Splat(part.centre, part.scales, part.quaternion, part.colour, part.opacity, uint(index));
            },
        },
    });
}

// The vegetable in your hand: low on your right, lying across your view, coming up into place as you take it.
function heldVeg(prep: Prep): SplatObject {
    const { heldKind, sinceHeld, hand, handDir } = prep;
    return SplatCollection.object({
        count: PER_VEG,
        generator: {
            generateSplat(index: TslNode) {
                const kind = heldKind.max(0);
                const raise = smoothstep(0, HAND.raise, sinceHeld);
                const at = vec3(hand).sub(vec3(0, float(1).sub(raise).mul(0.12), 0));
                const dir = normalize(vec3(handDir));
                const stemAt = at.sub(dir.mul(lengthOf(kind).mul(0.5)));
                const part = vegSplat(float(index), kind, stemAt, dir, float(21.7), 0);
                return GpuSplats.Splat(
                    part.centre,
                    part.scales,
                    part.quaternion,
                    part.colour,
                    part.opacity.mul(step(0, heldKind)),
                    uint(index),
                );
            },
        },
    });
}

/* the pot */

// How high the stock stands, a little higher for every slice in it.
const levelAt = (inPot: TslNode): TslNode => float(POT.level).add(inPot.div(POT.slots).mul(POT.rise)).mul(POT.height);

// Slot `slot` on the stock: a place on its surface, drifting slowly round, bobbing, each tilted its own way.
function potSlot(slot: TslNode, inPot: TslNode): { centre: TslNode; facing: TslNode } {
    const r1 = hash(slot.mul(1.31).add(0.2));
    const r2 = hash(slot.mul(2.17).add(0.5));
    const r3 = hash(slot.mul(3.71).add(0.9));
    const angle = r1.mul(Math.PI * 2).add(time.mul(0.04));
    // In far enough that even an onion slice stays inside the wall.
    const out = r2.sqrt().mul(POT.radius - POT.wall - VEG.onion.radius * 1.1);
    const bob = sin(time.mul(1.3).add(r1.mul(20))).mul(0.0012);
    const centre = vec3(...POT.centre).add(vec3(cos(angle).mul(out), levelAt(inPot).add(0.0015).add(bob), sin(angle).mul(out)));
    const tilt = r3.mul(0.25);
    const facing = normalize(up.add(vec3(cos(angle.add(r3.mul(9))), 0, sin(angle.add(r3.mul(9)))).mul(sin(tilt))));
    return { centre, facing };
}

// The pot. A cylinder is straight up its height and curved only round it, so its wall is tall strips of splats long
// up and down and narrow round: each strip shades smoothly up its length, the copper's reflections fall in vertical
// bands as copper's do, and its outline stays crisp because at the sides the strips are seen edge on. The hammer
// marks are their own splats, small glints scattered where the light catches the facets. The bead round the rim is a
// tube, its splats long round the pot. The handles are tubes swept along a loop, long along it, on a riveted plate.
function pot(prep: Prep): SplatObject {
    const eye = vec3(prep.eye);
    const outside = POT.strips * POT.segments;
    const inside = POT.inner * POT.innerSegments;
    const bead = POT.bead.around * POT.bead.tube;
    const handle = POT.handle.along * POT.handle.tube;
    const fixings = 4;
    return SplatCollection.object({
        count: outside + inside + bead + POT.glints + (handle + fixings) * 2 + POT.strips,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const centre = vec3(...POT.centre);
                const sun = normalize(light.add(vec3(0.4, 0, 0.6)));

                // A strip of the wall, outside or in: its angle round and how far up.
                const isOutside = i.lessThan(outside);
                const isInside = i.greaterThanEqual(outside).and(i.lessThan(outside + inside));
                const w = isOutside.select(i, i.sub(outside));
                const per = isOutside.select(float(POT.segments), float(POT.innerSegments));
                const count = isOutside.select(float(POT.strips), float(POT.inner));
                const strip = TSL.floor(w.div(per));
                const segment = w.sub(strip.mul(per));
                const angle = strip
                    .add(0.5)
                    .add(hash(strip.mul(1.7)).sub(0.5).mul(0.3))
                    .div(count)
                    .mul(Math.PI * 2);
                const round = vec3(cos(angle), 0, sin(angle));
                const tangent = vec3(sin(angle).negate(), 0, cos(angle));
                // Up the outside from just above the base to just under the bead; the inside from the bead down
                // past where the stock can be.
                const from = isOutside.select(float(0.012), float(POT.height * 0.42));
                const to = float(POT.height - 0.006);
                // Segments bunched toward each end of the strip and smaller there, so the end ones sit right at the
                // rim and the base and no soft splat reaches past either.
                const u = segment
                    .add(0.5)
                    .add(hash(w.mul(2.3)).sub(0.5).mul(0.2))
                    .div(per)
                    .clamp(0, 1);
                const bunched = u.sub(sin(u.mul(Math.PI * 2)).div(Math.PI * 2));
                const h = mix(from, to, bunched);
                const spacing = to
                    .sub(from)
                    .div(per)
                    .mul(float(1).sub(cos(u.mul(Math.PI * 2))))
                    .max(0.0012);
                const belly = float(1).add(sin(h.div(POT.height).mul(Math.PI)).mul(0.012));
                const r = isOutside.select(belly.mul(POT.radius), float(POT.radius - POT.wall));
                const wallAt = centre.add(round.mul(r)).add(vec3(0, h, 0));
                const wallNormal = isOutside.select(round, round.negate());
                // Copper: hammered, a reflected band of light where it faces the window and a soft second one round
                // from it, darker with age toward the base; tin inside, dull, darker down toward the stock.
                const facets = mx_noise_float(vec3(angle.mul(12), h.mul(60), 3)).mul(0.07);
                const age = smoothstep(0.35, 0, h.div(POT.height))
                    .mul(0.6)
                    .add(smoothstep(0.4, 0.8, mx_noise_float(vec3(angle.mul(2), h.mul(9), 8))).mul(0.25));
                // Metal shows what it reflects more than its own colour: mostly the dim room, warm-tinted by the
                // copper, a broad soft glow and a sharp bright band where it faces the window, darker low down where
                // it reflects the table.
                const up_ = h.div(POT.height);
                const tarnish = smoothstep(0.05, 0.55, mx_noise_float(vec3(angle.mul(2.5), up_.mul(5), 21)));
                const drips = smoothstep(0.35, 0.8, mx_noise_float(vec3(angle.mul(38), up_.mul(1.6), 23)))
                    .mul(smoothstep(0.2, 0.9, up_))
                    .mul(0.6);
                const soot = smoothstep(0.38, 0.02, up_.add(mx_noise_float(vec3(angle.mul(5), up_.mul(8), 25)).mul(0.08)));
                const speck = step(0.992, hash(TSL.floor(angle.mul(90)).add(TSL.floor(up_.mul(70)).mul(91.7)))).mul(
                    smoothstep(0.45, 0.15, up_).add(smoothstep(0.85, 0.97, up_)),
                );
                const copper = mix(
                    mix(mix(vec3(...POT.copper), vec3(...POT.patina), age), vec3(...POT.tarnish), tarnish.mul(0.55).add(drips)),
                    vec3(...POT.soot),
                    soot.mul(0.8),
                ).mul(float(1).add(facets));
                // Dents: the surface wavers a little, so what it reflects wavers with it.
                const dent = vec2(
                    mx_noise_float(vec3(angle.mul(7), up_.mul(9), 27)),
                    mx_noise_float(vec3(angle.mul(7), up_.mul(9), 29)),
                ).mul(0.12);
                const surface = normalize(round.add(tangent.mul(dent.x)).add(up.mul(dent.y)));
                // What you see reflected there: your view bounced off the wall, into the dim room, or the arched
                // window's light, a bright upright band on a cylinder; more reflective where it turns away from you.
                const view = normalize(wallAt.sub(eye));
                const bounce = view.sub(surface.mul(dot(view, surface).mul(2)));
                const toWindow = dot(bounce, WINDOW).max(0);
                const grazing = float(1).sub(dot(view, round).abs()).pow(3);
                const reflected = vec3(...POT.room)
                    .mul(mix(0.6, 1.3, smoothstep(-0.4, 0.6, bounce.y)))
                    .add(vec3(...POT.window).mul(pow(toWindow, 10).mul(0.9).add(pow(toWindow, 60).mul(1.4))));
                // Dulled where it's tarnished or sooty: less mirror, more of its own colour.
                const dull = tarnish.mul(0.5).add(soot).add(drips).min(1);
                const shiny = copper.mul(reflected).mul(mix(2.6, 3.4, grazing));
                const matte = shaded(copper, round, 0.5).mul(1.05);
                const weathered = mix(shiny, matte, dull.mul(0.75));
                const grey = dot(weathered, vec3(0.3, 0.55, 0.15));
                const copperColour = mix(mix(weathered, vec3(grey), 0.18), shaded(vec3(...POT.verdigris), round, 0.5), speck);
                const tinColour = vec3(...POT.tin)
                    .mul(mix(0.35, 0.75, h.div(POT.height)))
                    .mul(hash(strip).mul(0.08).add(0.96));
                const wallScales = vec3(
                    float(1)
                        .div(count)
                        .mul(r.mul(Math.PI * 2 * 0.95)),
                    0.0004,
                    spacing.mul(0.75),
                );

                // The bead: a tube round the rim.
                const b = i.sub(outside + inside);
                const isBead = b.greaterThanEqual(0).and(b.lessThan(bead));
                const br = TSL.floor(b.div(POT.bead.around));
                const ba = b
                    .sub(br.mul(POT.bead.around))
                    .add(0.5)
                    .add(br.mul(0.5))
                    .div(POT.bead.around)
                    .mul(Math.PI * 2);
                const bRound = vec3(cos(ba), 0, sin(ba));
                const tube = br
                    .add(0.5)
                    .div(POT.bead.tube)
                    .mul(Math.PI * 1.4)
                    .sub(0.2);
                const beadNormal = bRound.mul(cos(tube)).add(up.mul(sin(tube)));
                const beadAt = centre
                    .add(bRound.mul(POT.radius - POT.bead.radius * 0.4))
                    .add(vec3(0, POT.height - POT.bead.radius, 0))
                    .add(beadNormal.mul(POT.bead.radius));
                const beadColour = shaded(vec3(...POT.copper).mul(1.1), beadNormal, 0.5).add(
                    vec3(1, 0.85, 0.7).mul(pow(dot(beadNormal, sun).max(0), 20).mul(0.5)),
                );
                const beadScales = vec3(
                    float((Math.PI * 2 * POT.radius) / POT.bead.around).mul(0.9),
                    0.0003,
                    float((Math.PI * 1.4 * POT.bead.radius) / POT.bead.tube).mul(0.75),
                );

                // A glint: a hammer facet catching the light, on the lit side.
                const g = b.sub(bead);
                const isGlint = g.greaterThanEqual(0).and(g.lessThan(POT.glints));
                const ga = hash(g.mul(1.9)).mul(Math.PI * 2);
                const gh = mix(0.02, POT.height - 0.01, hash(g.mul(3.1)));
                const gRound = vec3(cos(ga), 0, sin(ga));
                const glintAt = centre.add(gRound.mul(POT.radius * 1.012 + 0.0004)).add(vec3(0, gh, 0));
                // A facet only flashes where it tips the window's light into your eye, each tipped a little its own way.
                const gView = normalize(glintAt.sub(eye));
                const tipped = normalize(gRound.add(vec3(hash(g.mul(8.1)).sub(0.5), hash(g.mul(9.7)).sub(0.5), 0).mul(0.5)));
                const gBounce = gView.sub(tipped.mul(dot(gView, tipped).mul(2)));
                const glintStrength = smoothstep(0.93, 0.99, dot(gBounce, WINDOW));
                const glintSize = mix(0.002, 0.0045, hash(g.mul(7.7)));

                // A handle: a tube swept along a loop standing out from the side, and its riveted plate.
                const hk = g.sub(POT.glints);
                const which = TSL.floor(hk.div(handle + fixings));
                const hl = hk.sub(which.mul(handle + fixings));
                const isHandle = hk
                    .greaterThanEqual(0)
                    .and(hk.lessThan((handle + fixings) * 2))
                    .and(hl.lessThan(handle));
                const isFixing = hk
                    .greaterThanEqual(0)
                    .and(hk.lessThan((handle + fixings) * 2))
                    .and(hl.greaterThanEqual(handle));
                const outward = which.equal(0).select(along, along.negate());
                const sideways = TSL.cross(up, outward);
                const hh = POT.height * POT.handle.height;
                const seg = TSL.floor(hl.div(POT.handle.tube));
                const t = seg.add(0.5).div(POT.handle.along);
                // The loop: out from the wall, round, and back, a flattened U seen from above.
                const loopAt = (u: TslNode) =>
                    centre
                        .add(outward.mul(float(POT.radius).add(sin(u.mul(Math.PI)).mul(POT.handle.reach))))
                        .add(sideways.mul(cos(u.mul(Math.PI)).mul(POT.handle.span / 2)))
                        .add(vec3(0, hh, 0));
                const pathAt = loopAt(t);
                const ahead = normalize(loopAt(t.add(0.01)).sub(pathAt));
                const ring = hl
                    .sub(seg.mul(POT.handle.tube))
                    .add(0.5)
                    .div(POT.handle.tube)
                    .mul(Math.PI * 2);
                const sideOf = normalize(TSL.cross(ahead, up));
                const tubeNormal = sideOf.mul(cos(ring)).add(up.mul(sin(ring)));
                const handleAt = pathAt.add(tubeNormal.mul(POT.handle.thickness));
                const brass = shaded(vec3(0.42, 0.34, 0.23), tubeNormal, 0.45).add(
                    vec3(1, 0.9, 0.7).mul(pow(dot(tubeNormal, sun).max(0), 16).mul(0.4)),
                );
                const handleScales = vec3(
                    float((Math.PI * POT.handle.span * 0.5 + POT.handle.reach * 2) / POT.handle.along).mul(0.9),
                    0.0003,
                    float((Math.PI * 2 * POT.handle.thickness) / POT.handle.tube).mul(0.7),
                );
                // The fixings: a small collar where each end of the loop meets the wall, and a rivet head beside it.
                const f = hl.sub(handle);
                const end = f.mod(2).mul(2).sub(1);
                const isRivet = f.greaterThanEqual(2);
                const fixAt = centre
                    .add(outward.mul(float(POT.radius * 1.01).add(isRivet.select(float(0.002), float(0.0005)))))
                    .add(sideways.mul(end.mul(POT.handle.span / 2)))
                    .add(vec3(0, hh, 0));
                const fixColour = isRivet.select(
                    shaded(vec3(0.7, 0.55, 0.32), outward, 0.5),
                    shaded(vec3(0.5, 0.36, 0.2), outward, 0.5),
                );
                const fixScales = isRivet.select(vec3(0.0016, 0.0008, 0.0016), vec3(0.0045, 0.0004, 0.006));

                // The base: a dark line where it stands on the table.
                const fb = hk.sub((handle + fixings) * 2);
                const fa = fb
                    .add(0.5)
                    .div(POT.strips)
                    .mul(Math.PI * 2);
                const footRound = vec3(cos(fa), 0, sin(fa));
                const footAt = centre.add(footRound.mul(POT.radius * 0.99)).add(vec3(0, 0.003, 0));

                const where = isOutside
                    .or(isInside)
                    .select(
                        wallAt,
                        isBead.select(beadAt, isGlint.select(glintAt, isHandle.select(handleAt, isFixing.select(fixAt, footAt)))),
                    );
                const quaternion = isOutside
                    .or(isInside)
                    .select(
                        basis(tangent, wallNormal),
                        isBead.select(
                            basis(vec3(sin(ba).negate(), 0, cos(ba)), beadNormal),
                            isGlint.select(
                                basis(vec3(sin(ga).negate(), 0, cos(ga)), gRound),
                                isHandle.select(
                                    basis(ahead, tubeNormal),
                                    isFixing.select(basis(sideways, outward), basis(vec3(sin(fa).negate(), 0, cos(fa)), up)),
                                ),
                            ),
                        ),
                    );
                const scales = isOutside
                    .or(isInside)
                    .select(
                        wallScales,
                        isBead.select(
                            beadScales,
                            isGlint.select(
                                vec3(glintSize.mul(0.6), 0.0002, glintSize),
                                isHandle.select(
                                    handleScales,
                                    isFixing.select(
                                        fixScales,
                                        vec3(float((Math.PI * 2 * POT.radius) / POT.strips).mul(0.9), 0.0003, 0.002),
                                    ),
                                ),
                            ),
                        ),
                    );
                const colour = isOutside.select(
                    copperColour,
                    isInside.select(
                        tinColour,
                        isBead.select(
                            beadColour,
                            isGlint.select(
                                vec3(1, 0.82, 0.66),
                                isHandle.select(brass, isFixing.select(fixColour, vec3(0.05, 0.035, 0.03))),
                            ),
                        ),
                    ),
                );
                // The wall's inside and outside are each only seen from their own side: one turned away from you is left out,
                // or its long splats sort wrongly against the other side's and show through it.
                const facesYou = dot(wallNormal, eye.sub(wallAt)).greaterThan(isOutside.select(float(-0.004), float(0)));
                const opacity = isGlint.select(
                    glintStrength.mul(0.8),
                    isOutside.or(isInside).select(facesYou.select(float(0.95), float(0)), float(0.95)),
                );
                return GpuSplats.Splat(where, scales, quaternion, colour, opacity, uint(index));
            },
        },
        params: { lodInflate: false },
    });
}

// The stock. A still liquid is flat, so its surface is a few large soft splats, its colour what's gone into it,
// darker toward the wall and catching a gleam of the window; where it meets the tin it climbs in a thin bright line;
// drops of fat float on it, each a small round glint.
function stock(prep: Prep): SplatObject {
    const { inPot, stock: colour } = prep;
    const rings = 12;
    const around = 64;
    const surface = rings * around;
    const meniscus = 120;
    return SplatCollection.object({
        count: surface + meniscus + POT.fat,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const level = levelAt(inPot);
                const isSurface = i.lessThan(surface);
                const isMeniscus = i.greaterThanEqual(surface).and(i.lessThan(surface + meniscus));
                const inner = POT.radius - POT.wall;

                const ring = TSL.floor(i.div(around));
                const out = ring.add(0.5).div(rings);
                const angle = i
                    .sub(ring.mul(around))
                    .add(0.5)
                    .add(hash(ring))
                    .add(hash(i.mul(1.7)).sub(0.5).mul(0.5))
                    .div(around)
                    .mul(Math.PI * 2);
                // Every splat's soft edge kept inside the wall, so none shows through the copper.
                const r = out.mul(inner - (inner / rings) * 1.6);
                const surfaceAt = vec3(...POT.centre).add(vec3(cos(angle).mul(r), level, sin(angle).mul(r)));
                const p = vec2(cos(angle).mul(r), sin(angle).mul(r));
                const gleam = smoothstep(0.5, 1, mx_noise_float(vec3(p.mul(18).add(vec2(time.mul(0.05), 0)), 5)))
                    .mul(0.1)
                    .add(pow(smoothstep(0.9, 0, TSL.length(p.sub(vec2(-0.03, 0.03))).div(inner)), 3).mul(0.12));
                const surfaceColour = vec3(colour)
                    .mul(mix(1.05, 0.7, out.mul(out)))
                    .add(gleam);
                const cell = float((Math.PI * 2) / around)
                    .mul(r)
                    .max((inner / rings) * 0.8);

                const m = i.sub(surface);
                const ma = m
                    .add(0.5)
                    .div(meniscus)
                    .mul(Math.PI * 2);
                const meniscusAt = vec3(...POT.centre).add(
                    vec3(cos(ma).mul(inner - 0.0012), level.add(0.0012), sin(ma).mul(inner - 0.0012)),
                );

                const d = i.sub(surface + meniscus);
                const da = hash(d.mul(2.3))
                    .mul(Math.PI * 2)
                    .add(time.mul(0.03));
                const dr = hash(d.mul(4.1))
                    .sqrt()
                    .mul(inner * 0.85);
                const fatAt = vec3(...POT.centre).add(vec3(cos(da).mul(dr), level.add(0.0006), sin(da).mul(dr)));
                const fatSize = mix(0.0012, 0.004, pow(hash(d.mul(6.7)), 2));

                const where = isSurface.select(surfaceAt, isMeniscus.select(meniscusAt, fatAt));
                const quaternion = isSurface.select(
                    basis(vec3(sin(angle).negate(), 0, cos(angle)), up),
                    basis(vec3(sin(ma).negate(), 0, cos(ma)), up),
                );
                const scales = isSurface.select(
                    vec3(cell.mul(0.85).min(inner / rings), 0.0003, float(inner / rings).mul(0.6)),
                    isMeniscus.select(
                        vec3(float((Math.PI * 2 * inner) / meniscus).mul(0.8), 0.0002, 0.0009),
                        vec3(fatSize, 0.0002, fatSize),
                    ),
                );
                const rgb = isSurface.select(
                    surfaceColour,
                    isMeniscus.select(
                        vec3(colour).mul(1.25).add(0.08),
                        vec3(colour)
                            .mul(1.2)
                            .add(vec3(0.18, 0.15, 0.06)),
                    ),
                );
                const opacity = isSurface.select(float(0.97), isMeniscus.select(float(0.6), float(0.7)));
                return GpuSplats.Splat(where, scales, quaternion, rgb, opacity, uint(index));
            },
        },
    });
}

// A splash where each slice lands, and a bigger one for the stub: a few drops of stock thrown up and falling back,
// and a ring spreading out over the surface and fading.
const SPLASH = { drops: 7, ring: 20, life: 0.6 };
function splashes(prep: Prep): SplatObject {
    const { swept, sinceSweep, before, inPot, stock: colour } = prep;
    const each = SPLASH.drops + SPLASH.ring;
    return SplatCollection.object({
        count: (MAX_CHOPS + 1) * each,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const n = TSL.floor(i.div(each));
                const k = i.sub(n.mul(each));
                const isStub = n.equal(MAX_CHOPS);
                const lands = isStub.select(float(SWEEP_DONE), n.div(swept.max(1)).mul(SWEEP.spread).add(SWEEP.flight));
                const since = sinceSweep.sub(lands);
                const live = since
                    .greaterThan(0)
                    .and(since.lessThan(SPLASH.life))
                    .and(isStub.select(swept.greaterThan(0.5), n.lessThan(swept)));
                const level = levelAt(inPot);
                const spot = isStub.select(
                    vec3(...POT.centre).add(vec3(0, level, 0)),
                    potSlot(min(before.add(n), POT.slots - 1), inPot).centre,
                );
                const big = isStub.select(float(1.5), float(1));
                // Catching the light: paler than the stock itself.
                const wet = mix(vec3(colour), vec3(0.95, 0.92, 0.85), 0.55);

                // A drop: thrown up and out, falling back under gravity, gone when it's back in.
                const r = vec3(hash(i.mul(1.3)), hash(i.mul(2.9)), hash(i.mul(4.7)));
                const a = r.x.mul(Math.PI * 2);
                const out = mix(0.1, 0.22, r.y).mul(big);
                const upward = mix(0.4, 0.7, r.z).mul(big.sqrt());
                const t = since.max(0);
                const dropAt = spot.add(
                    vec3(cos(a).mul(out).mul(t), upward.mul(t).sub(t.mul(t).mul(4.9)), sin(a).mul(out).mul(t)),
                );
                const dropLive = dropAt.y.greaterThan(spot.y);
                const dropSize = mix(0.002, 0.0035, r.y).mul(big);

                // The ring: spreading over the surface, thinning out as it goes.
                const ringAngle = k
                    .sub(SPLASH.drops)
                    .add(0.5)
                    .div(SPLASH.ring)
                    .mul(Math.PI * 2);
                const radius = float(0.005).add(t.mul(0.08).mul(big));
                const ringAt = spot.add(vec3(cos(ringAngle).mul(radius), 0.001, sin(ringAngle).mul(radius)));
                const fade = float(1).sub(t.div(SPLASH.life));

                const isDrop = k.lessThan(SPLASH.drops);
                const centre = isDrop.select(dropAt, ringAt);
                const scales = isDrop.select(vec3(dropSize), vec3(radius.mul((Math.PI * 2 * 0.9) / SPLASH.ring), 0.0002, 0.0012));
                const quaternion = isDrop.select(vec4(0, 0, 0, 1), basis(vec3(sin(ringAngle).negate(), 0, cos(ringAngle)), up));
                const opacity = isDrop
                    .select(dropLive.select(fade.mul(0.95), float(0)), fade.mul(fade).mul(0.7))
                    .mul(live.select(float(1), float(0)));
                return GpuSplats.Splat(centre, scales, quaternion, wet, opacity, uint(index));
            },
        },
    });
}

// The slices floating on the stock, each its own kind.
function potSlices(prep: Prep): SplatObject {
    const { inPot, slotKinds } = prep;
    return SplatCollection.object({
        count: POT.slots * PER_SLICE,
        generator: {
            generateSplat(index: TslNode) {
                const slot = TSL.floor(float(index).div(PER_SLICE));
                const kind = slotKinds.element(uint(slot));
                const { centre, facing } = potSlot(slot, inPot);
                const radius = radiusAt(mix(0.2, 0.85, hash(slot.mul(5.1))), kind);
                const part = sliceSplat(float(index).sub(slot.mul(PER_SLICE)), kind, centre, facing, radius, slot.mul(3.7));
                return GpuSplats.Splat(
                    part.centre,
                    part.scales,
                    part.quaternion,
                    part.colour,
                    part.opacity.mul(step(slot.add(0.5), inPot)),
                    uint(index),
                );
            },
        },
        params: { lodInflate: false },
    });
}

/* the knife */

// The blade is rows of thin splats running heel to point and following its curve, brushed steel, each row's fade
// kept inside the hairlines that trace its edge, its bevel and its spine; a hairline closes the heel. The handle is a
// rounded solid in rings, with a steel bolster and rivets, so its outline is crisp from any side.
function knife(prep: Prep): SplatObject {
    const { grip, boardKind, stroke: strokeAt, knifeAt } = prep;
    const rows = 16;
    const runs = 24;
    const fill = rows * runs;
    const line = 48;
    const lines = 3;
    const heel = 6;
    const blade = fill + line * lines + heel;
    const handleRings = 20;
    const handleAround = 12;
    const handle = handleRings * handleAround;
    const bolster = 2 * handleAround;
    const rivets = 6;
    return SplatCollection.object({
        count: blade + handle + bolster + rivets,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                // At rest it lies flat on the board, front right. A chop picks it up and rocks it on its tip: the
                // heel swings down through the cut to the board and back up; between chops it hovers there, tip
                // down, and is laid back down if you stop.
                const kind = boardKind.max(0);
                const length = lengthOf(kind);
                const next = float(LIES.end).sub(length).add(cutAt(knifeAt, kind).mul(length));
                const held = smoothstep(0, 1, grip);
                // Gathering speed into the cut.
                const stroke = pow(strokeAt, 1.6);
                // Held, the heel sits out in front, so the blade crosses the vegetable near its heel, at the cut.
                const out = 0.035;
                const heldHeel = onBoard(next.add(out * Math.tan(KNIFE.slant)), float(LIES.back + out), 0);
                const restHeel = onBoard(KNIFE.lying[0], KNIFE.lying[1], 0.003);
                const heelAt = mix(restHeel, heldHeel, held).add(vec3(0, sin(held.mul(Math.PI)).mul(0.03), 0));
                // Held, it stands on its edge pointing back and left; at rest it lies on its flat pointing left.
                const slanted = normalize(
                    toward
                        .negate()
                        .mul(Math.cos(KNIFE.slant))
                        .sub(along.mul(Math.sin(KNIFE.slant))),
                );
                const pointing = normalize(mix(normalize(along.negate().add(toward.mul(-0.12))), slanted, held));
                const tilted = normalize(mix(up, TSL.cross(pointing, up), held));
                const plane = normalize(tilted.sub(pointing.mul(dot(tilted, pointing))));
                const height = TSL.cross(plane, pointing);

                // The blade's edge and spine `u` of the way from heel to point, metres up from the edge's lowest.
                const edgeAt = (u: TslNode) => pow(u.sub(0.4).div(0.6).clamp(0, 1), 1.7).mul(KNIFE.height * KNIFE.point);
                const spineAt = (u: TslNode) =>
                    float(KNIFE.height).sub(pow(u.sub(0.5).div(0.5).clamp(0, 1), 1.6).mul(KNIFE.height * (1 - KNIFE.point)));
                // Which part of the blade: the fill rows, a traced line (edge, bevel, spine), or the heel.
                const isFill = i.lessThan(fill);
                const l = i.sub(fill);
                const isLine = l.greaterThanEqual(0).and(l.lessThan(line * lines));
                const which = TSL.floor(l.div(line));
                const isEdge = isLine.and(which.equal(0));
                const isBevel = isLine.and(which.equal(1));
                const isHeel = i.greaterThanEqual(fill + line * lines).and(i.lessThan(blade));
                const row = TSL.floor(i.div(runs));
                // Fill rows run from just in from the heel to just short of the point, between the bevel and spine
                // lines, kept in from them by their own fade.
                const fillU = mix(
                    0.08,
                    0.88,
                    i
                        .sub(row.mul(runs))
                        .add(hash(row.mul(1.7)).sub(0.5))
                        .add(hash(i.mul(2.1)).sub(0.5).mul(0.5))
                        .div(runs - 1),
                ).clamp(0.06, 0.9);
                const fillV = mix(0.2, 0.92, row.div(rows - 1));
                const lineU = l.sub(which.mul(line)).add(0.5).div(line);
                const heelV = mix(
                    0.08,
                    0.92,
                    i
                        .sub(fill + line * lines)
                        .add(0.5)
                        .div(heel),
                );
                const u = isFill.select(fillU, isHeel.select(float(0.004), lineU)).toVar();
                const v = isFill.select(
                    fillV,
                    isHeel.select(heelV, isEdge.select(float(0), isBevel.select(float(0.1), float(1)))),
                );
                const yAt = (at: TslNode) => mix(edgeAt(at), spineAt(at), v);
                const y = yAt(u);
                const slope = yAt(u.add(0.01))
                    .sub(y)
                    .div(0.01 * KNIFE.blade);
                const span = spineAt(u).sub(edgeAt(u)).max(0.0008);
                const bladeAt = heelAt.add(pointing.mul(u.mul(KNIFE.blade))).add(height.mul(y));
                const bladeDir = isHeel.select(height, normalize(pointing.add(height.mul(slope))));
                const stretch = slope.mul(slope).add(1).sqrt();
                const bladeScales = isFill.select(
                    vec3(
                        float((KNIFE.blade * 0.8) / (runs - 1))
                            .mul(0.8)
                            .mul(stretch),
                        0.0002,
                        span.mul(0.72 / (rows - 1)).mul(0.85),
                    ),
                    isHeel.select(
                        vec3(span.div(heel).mul(0.3), 0.0002, 0.0005),
                        vec3(
                            float(KNIFE.blade / line)
                                .mul(0.62)
                                .mul(stretch),
                            0.0002,
                            isBevel.select(float(0.0014), float(0.0005)),
                        ),
                    ),
                );
                // Bright on the edge, the bevel band a shade lighter than the face; the face brushed in streaks with
                // a soft band of light across it; the spine and heel dark.
                const streak = hash(row.add(3.3)).sub(0.5).mul(0.08);
                const glow = smoothstep(0.15, 0.4, u)
                    .mul(smoothstep(0.75, 0.5, u))
                    .mul(smoothstep(0.35, 0.75, v))
                    .mul(0.12);
                const face = vec3(...KNIFE.steel.face)
                    .add(streak)
                    .add(glow);
                const steel = isEdge.select(
                    vec3(...KNIFE.steel.edge),
                    isBevel.select(vec3(...KNIFE.steel.bevel), isFill.select(face, vec3(...KNIFE.steel.spine))),
                );

                // The handle: rings round its axis back from the heel, an oval a little fuller toward the butt, closed
                // off round the butt; then a steel bolster at the heel and rivets on both faces.
                const k = i.sub(blade);
                const isBolster = k.greaterThanEqual(handle).and(k.lessThan(handle + bolster));
                const isRivet = k.greaterThanEqual(handle + bolster);
                const hr = TSL.floor(k.div(handleAround));
                const ringIndex = isBolster.select(k.sub(handle).div(handleAround).floor(), hr);
                const w = isBolster.select(ringIndex.mul(0.012).sub(0.008), ringIndex.add(0.5).div(handleRings));
                const around = k
                    .sub(hr.mul(handleAround))
                    .add(hash(hr.mul(4.3)))
                    .add(hash(k.mul(1.9)).sub(0.5).mul(0.6))
                    .div(handleAround)
                    .mul(Math.PI * 2);
                const fuller = mix(0.9, 1.08, smoothstep(0.5, 1, w));
                const butt = smoothstep(0.94, 1, w).mul(0.6);
                const girth = isBolster.select(float(1.02), fuller.mul(float(1).sub(butt)));
                const middle = height.mul(KNIFE.height * 0.6);
                const axis = heelAt.add(middle).add(pointing.mul(isBolster.select(w, w.mul(-KNIFE.handle).sub(0.012))));
                const ring = height.mul(cos(around).mul(KNIFE.girth[0])).add(plane.mul(sin(around).mul(KNIFE.girth[1])));
                const handleAt = axis.add(ring.mul(girth));
                const handleNormal = normalize(
                    height.mul(cos(around).div(KNIFE.girth[0])).add(plane.mul(sin(around).div(KNIFE.girth[1]))),
                );
                const handleScales = vec3(
                    float((KNIFE.handle / handleRings) * 0.85),
                    0.0003,
                    float((Math.PI * 2 * KNIFE.girth[0]) / handleAround)
                        .mul(girth)
                        .mul(0.85),
                );
                const r = k.sub(handle + bolster);
                const face_ = r.mod(2).mul(2).sub(1);
                const rivetAt = heelAt
                    .add(middle)
                    .add(
                        pointing.mul(
                            TSL.floor(r.div(2))
                                .add(0.5)
                                .div(3)
                                .mul(-KNIFE.handle * 0.8)
                                .sub(0.022),
                        ),
                    )
                    .add(plane.mul(face_.mul(KNIFE.girth[1] + 0.0004)));
                const grain = mx_noise_float(vec3(w.mul(2.5), around.mul(5), 4)).mul(0.07);
                const handleColour = isBolster.select(
                    shaded(vec3(...KNIFE.steel.face), handleNormal, 0.55),
                    shaded(vec3(...KNIFE.wood).add(grain), handleNormal, 0.5),
                );

                const isBlade = i.lessThan(blade);
                // The rock: everything turned about the tip, heel up; it slides forward a touch as it comes down.
                const tipAt = heelAt.add(pointing.mul(KNIFE.blade));
                const angle = held.mul(float(1).sub(stroke)).mul(-KNIFE.rock);
                const rock = vec4(plane.mul(sin(angle.mul(0.5))), cos(angle.mul(0.5)));
                const slide = pointing.mul(stroke.mul(KNIFE.slice).mul(held));
                const placed = (p: TslNode) => tipAt.add(GpuSplatMath.quatRotate(rock, p.sub(tipAt))).add(slide);
                const centre = placed(isBlade.select(bladeAt, isRivet.select(rivetAt, handleAt)));
                const quaternion = GpuSplatMath.quatMul(
                    rock,
                    isBlade.select(
                        basis(bladeDir, plane),
                        isRivet.select(basis(pointing, plane.mul(face_)), basis(pointing, handleNormal)),
                    ),
                );
                const scales = isBlade.select(
                    bladeScales,
                    isRivet.select(
                        vec3(0.0011, 0.0003, 0.0011),
                        isBolster.select(vec3(0.004, 0.0003, handleScales.z), handleScales),
                    ),
                );
                const colour = isBlade.select(steel, isRivet.select(vec3(0.5, 0.49, 0.46), handleColour));
                // Soft, so the steel and the wood melt together; only the edge and spine hairlines crisp.
                const crisp = isLine.and(isBevel.not());
                return GpuSplats.Splat(centre, scales, quaternion, colour, crisp.select(float(CRISP), float(0.95)), uint(index));
            },
        },
        params: { lodInflate: false },
    });
}

/* the sounds */

type Sound = { chop(): void; sweep(count: number): void; place(): void };

// A chop is a crisp crunch through the carrot and a woody tock as the blade meets the board; a sweep, a soft brush.
function initSound(): Sound {
    const context = new AudioContext();
    const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    // Everything through a lowpass: a soft, damped kitchen sound, not a click.
    const muffle = context.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 3200;
    muffle.connect(context.destination);

    const burst = (type: BiquadFilterType, frequency: number, q: number, volume: number, length: number, delay = 0) => {
        const at = context.currentTime + delay;
        const source = context.createBufferSource();
        source.buffer = noise;
        const filter = context.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = frequency;
        filter.Q.value = q;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(volume, at + Math.min(0.01, length * 0.2));
        gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        source.connect(filter).connect(gain).connect(muffle);
        source.start(at, Math.random() * 0.5, length + 0.02);
    };
    const tock = (frequency: number, volume: number, delay: number) => {
        const at = context.currentTime + delay;
        const oscillator = context.createOscillator();
        oscillator.frequency.setValueAtTime(frequency, at);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.8, at + 0.04);
        const gain = context.createGain();
        gain.gain.setValueAtTime(volume, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
        oscillator.connect(gain).connect(muffle);
        oscillator.start(at);
        oscillator.stop(at + 0.1);
    };

    const plop = (delay: number, pitch: number) => {
        const at = context.currentTime + delay;
        const base = (480 + Math.random() * 260) * pitch;
        const oscillator = context.createOscillator();
        oscillator.frequency.setValueAtTime(base, at);
        oscillator.frequency.exponentialRampToValueAtTime(base * 1.9, at + 0.045);
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.035 * (1.4 - pitch * 0.4), at + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
        oscillator.connect(gain).connect(muffle);
        oscillator.start(at);
        oscillator.stop(at + 0.08);
        burst('bandpass', 2400, 1.5, 0.012, 0.03, delay);
    };

    return {
        chop() {
            // Each chop a little different: pitch and level nudged. A short crisp crunch through the carrot, then
            // a light woody knock as the blade meets the board, all softened under the lowpass.
            const detune = 0.88 + Math.random() * 0.24;
            const level = 0.75 + Math.random() * 0.25;
            const strike = 0;
            burst('bandpass', 1700 * detune, 1.4, 0.05 * level, 0.03, strike);
            burst('bandpass', 850 * detune, 2, 0.07 * level, 0.04, strike + 0.015);
            tock(280 * detune, 0.09 * level, strike + 0.02);
        },
        // Something set down or picked up: a soft, low knock.
        place() {
            tock(190 * (0.9 + Math.random() * 0.2), 0.08, 0);
            burst('bandpass', 600, 1, 0.03, 0.05);
        },
        // The toss: a soft whoosh, then each slice plopping into the stock as it lands, a bloop that rises in pitch,
        // each its own; the stub a deeper plop last.
        sweep(count) {
            burst('bandpass', 700, 0.5, 0.025, 0.35);
            for (let coin = 0; coin < count; coin++) plop(landsAt(coin, count) + Math.random() * 0.02, 1);
            plop(SWEEP_DONE, 0.6);
        },
    };
}
