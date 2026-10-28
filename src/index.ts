import {
    addBroadphaseLayer,
    addObjectLayer,
    CastRayStatus,
    capsule,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    createWorld,
    createWorldSettings,
    enableCollision,
    type Filter,
    filter,
    type KCC,
    kcc,
    MotionType,
    registerAll,
    rigidBody,
    transformed,
    triangleMesh,
    updateWorld,
    type World,
} from 'crashcat';
import { quat, type Vec3, vec3, vec4 } from 'mathcat';
import { createRenderer, GpuArrays, loadSplats, SplatCollection, SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import kitchenUrl from '../assets/kitchen.spz?url';
import colliderUrl from '../assets/kitchen-collider.glb?url';
import footstep1Url from '../assets/sounds/wood_footstep.1.ogg?url';
import footstep2Url from '../assets/sounds/wood_footstep.2.ogg?url';
import './style.css';

/* settings */

const MAX_DT = 1 / 30;
// Splats are fill-bound: past this, more pixels cost more than they show.
const MAX_PIXEL_RATIO = 1.5;

const GRAVITY: Vec3 = [0, -9.81, 0];

const PLAYER = { height: 1.7, radius: 0.25, eye: 1.6, walk: 1.6, run: 3.2, jump: 3.6, accel: 10, friction: 8 };
const MAX_SLOPE = (50 * Math.PI) / 180;
const LOOK_SENSITIVITY = 0.0022;

// Where to look for open floor to spawn on, nearest the room's middle first.
const ROOM = { min: [-6, -5.5], max: [3, 3], middle: [-1.5, -1.2], floorBelow: 0.25 };

const FOOTSTEPS = { stride: 0.75, volume: 0.5, pitchJitter: 0.08 };

/* physics */

registerAll();

const worldSettings = createWorldSettings();
worldSettings.gravity = GRAVITY;
const BROADPHASE_MOVING = addBroadphaseLayer(worldSettings);
const BROADPHASE_STATIC = addBroadphaseLayer(worldSettings);
const LAYER_MOVING = addObjectLayer(worldSettings, BROADPHASE_MOVING);
const LAYER_STATIC = addObjectLayer(worldSettings, BROADPHASE_STATIC);
enableCollision(worldSettings, LAYER_MOVING, LAYER_STATIC);
enableCollision(worldSettings, LAYER_MOVING, LAYER_MOVING);

async function loadCollider(world: World) {
    const gltf = await new GLTFLoader().loadAsync(colliderUrl);
    gltf.scene.updateMatrixWorld(true);
    const positions: number[] = [];
    const indices: number[] = [];
    const v = new THREE.Vector3();
    gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const geometry = object.geometry as THREE.BufferGeometry;
        const position = geometry.getAttribute('position');
        const base = positions.length / 3;
        for (let i = 0; i < position.count; i++) {
            v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
            positions.push(v.x, v.y, v.z);
        }
        const index = geometry.getIndex();
        for (let i = 0; i < (index ? index.count : position.count); i++) indices.push(base + (index ? index.getX(i) : i));
    });
    rigidBody.create(world, {
        shape: triangleMesh.create({ positions, indices }),
        motionType: MotionType.STATIC,
        objectLayer: LAYER_STATIC,
    });
}

const staticOnly = filter.createEmpty();
filter.disableAllLayers(staticOnly, worldSettings.layers);
filter.enableObjectLayer(staticOnly, worldSettings.layers, LAYER_STATIC);
staticOnly.collisionMask = -1;
staticOnly.collisionGroups = -1;
const rayCollector = createClosestCastRayCollector();
const raySettings = createDefaultCastRaySettings();
raySettings.collideWithBackfaces = true;

function floorBelow(world: World, x: number, z: number, fromY: number, maxDistance: number): number | null {
    rayCollector.reset();
    castRay(world, rayCollector, raySettings, [x, fromY, z], [0, -1, 0], maxDistance, staticOnly);
    if (rayCollector.hit.status !== CastRayStatus.COLLIDING) return null;
    return fromY - rayCollector.hit.fraction * maxDistance;
}

function findSpawn(world: World): Vec3 {
    const candidates: [number, number][] = [];
    for (let x = ROOM.min[0]; x <= ROOM.max[0]; x += 0.5) {
        for (let z = ROOM.min[1]; z <= ROOM.max[1]; z += 0.5) candidates.push([x, z]);
    }
    const fromMiddle = ([x, z]: [number, number]) => Math.hypot(x - ROOM.middle[0], z - ROOM.middle[1]);
    candidates.sort((a, b) => fromMiddle(a) - fromMiddle(b));
    for (const [x, z] of candidates) {
        // Cast from just under head height, so a counter top reads as not-floor.
        const y = floorBelow(world, x, z, 1.5, 3);
        if (y !== null && y < ROOM.floorBelow) return [x, y + 0.05, z];
    }
    return [ROOM.middle[0], 1, ROOM.middle[1]];
}

/* player */

type Player = {
    controller: KCC;
    settings: kcc.UpdateSettings;
    filter: Filter;
    yaw: number;
    pitch: number;
};

function createPlayer(world: World, spawn: Vec3): Player {
    const shape = transformed.create({
        shape: capsule.create({ halfHeightOfCylinder: PLAYER.height / 2 - PLAYER.radius, radius: PLAYER.radius }),
        position: [0, PLAYER.height / 2, 0],
        quaternion: quat.create(),
    });
    const controller = kcc.create(
        {
            shape,
            up: [0, 1, 0],
            maxSlopeAngle: MAX_SLOPE,
            supportingVolumePlane: vec4.fromValues(0, 1, 0, -PLAYER.radius),
            backFaceMode: kcc.BackFaceMode.COLLIDE,
        },
        spawn,
        quat.create(),
    );
    kcc.add(world, controller);
    const settings = kcc.createDefaultUpdateSettings();
    vec3.set(settings.walkStairsStepUp, 0, 0.3, 0);
    return { controller, settings, filter: filter.create(world.settings.layers), yaw: Math.PI * 0.25, pitch: 0 };
}

const keys = new Set<string>();
const wish = vec3.create();
const horizontal = vec3.create();

function updatePlayer(world: World, player: Player, dt: number) {
    const { controller } = player;
    const forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    vec3.set(wish, strafe * cos - forward * sin, 0, -strafe * sin - forward * cos);
    if (vec3.length(wish) > 1) vec3.normalize(wish, wish);
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? PLAYER.run : PLAYER.walk;

    kcc.updateGroundVelocity(world, controller);
    const onGround = controller.ground.state === kcc.GroundState.ON_GROUND;
    const velocity = controller.linearVelocity;
    vec3.set(horizontal, velocity[0], 0, velocity[2]);
    const blend = 1 - Math.exp(-(vec3.length(wish) > 0 ? PLAYER.accel : PLAYER.friction) * dt * (onGround ? 1 : 0.2));
    horizontal[0] += (wish[0] * speed - horizontal[0]) * blend;
    horizontal[2] += (wish[2] * speed - horizontal[2]) * blend;

    let vertical = onGround ? Math.max(velocity[1], 0) : velocity[1];
    const jumping = onGround && keys.has('Space');
    if (jumping) vertical = PLAYER.jump;
    vertical += GRAVITY[1] * dt;
    vec3.set(velocity, horizontal[0], vertical, horizontal[2]);

    if (jumping) vec3.zero(player.settings.stickToFloorStepDown);
    else vec3.set(player.settings.stickToFloorStepDown, 0, -0.5, 0);
    kcc.update(world, controller, dt, GRAVITY, player.settings, undefined, player.filter);
}

function bindLook(canvas: HTMLCanvasElement, player: Player, onFirstClick: () => void) {
    canvas.addEventListener('click', () => {
        onFirstClick();
        canvas.requestPointerLock();
    });
    document.addEventListener('mousemove', (event) => {
        if (document.pointerLockElement !== canvas) return;
        player.yaw -= event.movementX * LOOK_SENSITIVITY;
        player.pitch = THREE.MathUtils.clamp(player.pitch - event.movementY * LOOK_SENSITIVITY, -1.5, 1.5);
    });
    document.addEventListener('pointerlockchange', () => {
        document.getElementById('hint')?.classList.toggle('hidden', document.pointerLockElement === canvas);
    });
    window.addEventListener('keydown', (event) => keys.add(event.code));
    window.addEventListener('keyup', (event) => keys.delete(event.code));
    window.addEventListener('blur', () => keys.clear());
}

/* footsteps */

function createFootsteps() {
    let context: AudioContext | undefined;
    let buffers: AudioBuffer[] = [];
    let walked = 0;
    let last = -1;

    return {
        async unlock() {
            if (context) return;
            const audio = new AudioContext();
            context = audio;
            buffers = await Promise.all(
                [footstep1Url, footstep2Url].map(async (url) => audio.decodeAudioData(await (await fetch(url)).arrayBuffer())),
            );
        },
        update(distance: number, onGround: boolean) {
            if (!onGround || !context || buffers.length === 0) return;
            walked += distance;
            if (walked < FOOTSTEPS.stride) return;
            walked = 0;
            // Never the same clip twice running.
            last = (last + 1 + Math.floor(Math.random() * (buffers.length - 1))) % buffers.length;
            const source = context.createBufferSource();
            source.buffer = buffers[last];
            source.playbackRate.value = 1 + (Math.random() * 2 - 1) * FOOTSTEPS.pitchJitter;
            const gain = context.createGain();
            gain.gain.value = FOOTSTEPS.volume;
            source.connect(gain).connect(context.destination);
            source.start();
        },
    };
}

/* the loop */

async function start() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

    // MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const world = createWorld(worldSettings);
    const [data] = await Promise.all([loadSplats(kitchenUrl), loadCollider(world)]);
    const kitchen = SplatCollection.arrays(GpuArrays.fromData(renderer, data));
    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([kitchen]) });
    splats.raycast = () => {};
    scene.add(splats);

    const player = createPlayer(world, findSpawn(world));
    const footsteps = createFootsteps();
    bindLook(renderer.domElement, player, () => footsteps.unlock());

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const feet = vec3.create();
    let last = performance.now();
    let frames = 0;
    renderer.setAnimationLoop(() => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;

        vec3.copy(feet, player.controller.position);
        updatePlayer(world, player, dt);
        updateWorld(world, undefined, dt);
        const position = player.controller.position;
        footsteps.update(
            Math.hypot(position[0] - feet[0], position[2] - feet[2]),
            player.controller.ground.state === kcc.GroundState.ON_GROUND,
        );

        camera.position.set(position[0], position[1] + PLAYER.eye, position[2]);
        camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
        renderer.render(scene, camera);

        // Past the first frames' shader compiles.
        if (++frames === 3) {
            document.getElementById('loading')?.classList.add('hidden');
            document.getElementById('hint')?.classList.remove('hidden');
        }
    });
}

start();
