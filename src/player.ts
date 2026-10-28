import { capsule, type Filter, filter, type KCC, kcc, transformed } from 'crashcat';
import { quat, type Vec3, vec3, vec4 } from 'mathcat';
import * as THREE from 'three';
import { consumeLook, type Input, isHeld } from './input';
import { floorBelow, GRAVITY, type Physics } from './physics';

const PLAYER = { height: 1.7, radius: 0.25, eye: 1.6, walk: 1.6, run: 3.2, jump: 3.6, accel: 10, friction: 8 };
const MAX_SLOPE = (50 * Math.PI) / 180;
const LOOK_SENSITIVITY = 0.0022;

// Where to look for open floor to spawn on, nearest the room's middle first.
const ROOM = { min: [-6, -5.5], max: [3, 3], middle: [-1.5, -1.2], floorBelow: 0.25 };

export type Player = {
    controller: KCC;
    settings: kcc.UpdateSettings;
    filter: Filter;
    yaw: number;
    pitch: number;
    /** Horizontal distance moved last update. */
    moved: number;
};

export function initPlayer(physics: Physics): Player {
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
        findSpawn(physics),
        quat.create(),
    );
    kcc.add(physics.world, controller);
    const settings = kcc.createDefaultUpdateSettings();
    vec3.set(settings.walkStairsStepUp, 0, 0.3, 0);
    return {
        controller,
        settings,
        filter: filter.create(physics.world.settings.layers),
        yaw: Math.PI * 0.25,
        pitch: 0,
        moved: 0,
    };
}

const wish = vec3.create();
const horizontal = vec3.create();
const before = vec3.create();

export function updatePlayer(player: Player, physics: Physics, input: Input, dt: number): void {
    const [lookX, lookY] = consumeLook(input);
    player.yaw -= lookX * LOOK_SENSITIVITY;
    player.pitch = THREE.MathUtils.clamp(player.pitch - lookY * LOOK_SENSITIVITY, -1.5, 1.5);

    const forward = (isHeld(input, 'KeyW', 'ArrowUp') ? 1 : 0) - (isHeld(input, 'KeyS', 'ArrowDown') ? 1 : 0);
    const strafe = (isHeld(input, 'KeyD', 'ArrowRight') ? 1 : 0) - (isHeld(input, 'KeyA', 'ArrowLeft') ? 1 : 0);
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    vec3.set(wish, strafe * cos - forward * sin, 0, -strafe * sin - forward * cos);
    if (vec3.length(wish) > 1) vec3.normalize(wish, wish);
    const speed = isHeld(input, 'ShiftLeft', 'ShiftRight') ? PLAYER.run : PLAYER.walk;

    const { controller } = player;
    kcc.updateGroundVelocity(physics.world, controller);
    const grounded = isGrounded(player);
    const velocity = controller.linearVelocity;
    vec3.set(horizontal, velocity[0], 0, velocity[2]);
    const blend = 1 - Math.exp(-(vec3.length(wish) > 0 ? PLAYER.accel : PLAYER.friction) * dt * (grounded ? 1 : 0.2));
    horizontal[0] += (wish[0] * speed - horizontal[0]) * blend;
    horizontal[2] += (wish[2] * speed - horizontal[2]) * blend;

    let vertical = grounded ? Math.max(velocity[1], 0) : velocity[1];
    const jumping = grounded && isHeld(input, 'Space');
    if (jumping) vertical = PLAYER.jump;
    vertical += GRAVITY[1] * dt;
    vec3.set(velocity, horizontal[0], vertical, horizontal[2]);

    if (jumping) vec3.zero(player.settings.stickToFloorStepDown);
    else vec3.set(player.settings.stickToFloorStepDown, 0, -0.5, 0);
    vec3.copy(before, controller.position);
    kcc.update(physics.world, controller, dt, GRAVITY, player.settings, undefined, player.filter);
    player.moved = Math.hypot(controller.position[0] - before[0], controller.position[2] - before[2]);
}

export function isGrounded(player: Player): boolean {
    return player.controller.ground.state === kcc.GroundState.ON_GROUND;
}

export function applyPlayerCamera(player: Player, camera: THREE.Camera): void {
    const [x, y, z] = player.controller.position;
    camera.position.set(x, y + PLAYER.eye, z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
}

function findSpawn(physics: Physics): Vec3 {
    const candidates: [number, number][] = [];
    for (let x = ROOM.min[0]; x <= ROOM.max[0]; x += 0.5) {
        for (let z = ROOM.min[1]; z <= ROOM.max[1]; z += 0.5) candidates.push([x, z]);
    }
    const fromMiddle = ([x, z]: [number, number]) => Math.hypot(x - ROOM.middle[0], z - ROOM.middle[1]);
    candidates.sort((a, b) => fromMiddle(a) - fromMiddle(b));
    for (const [x, z] of candidates) {
        // Cast from just under head height, so a counter top reads as not-floor.
        const y = floorBelow(physics, x, z, 1.5, 3);
        if (y !== null && y < ROOM.floorBelow) return [x, y + 0.05, z];
    }
    return [ROOM.middle[0], 1, ROOM.middle[1]];
}
