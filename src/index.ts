import { createRenderer, GpuArrays, loadSplats, SplatCollection, SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import kitchenUrl from '../assets/kitchen.spz?url';
import colliderUrl from '../assets/kitchen-collider.glb?url';
import { initFootsteps, unlockFootsteps, updateFootsteps } from './footsteps';
import { initInput } from './input';
import { initPhysics, loadCollider, updatePhysics } from './physics';
import { applyPlayerCamera, initPlayer, isGrounded, updatePlayer } from './player';
import './style.css';

const MAX_DT = 1 / 30;
// Splats are fill-bound: past this, more pixels cost more than they show.
const MAX_PIXEL_RATIO = 1.5;

async function init() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

    // MSAA doesn't help splats.
    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const physics = initPhysics();
    const [data] = await Promise.all([loadSplats(kitchenUrl), loadCollider(physics, colliderUrl)]);
    const kitchen = SplatCollection.arrays(GpuArrays.fromData(renderer, data));
    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([kitchen]) });
    splats.raycast = () => {};
    scene.add(splats);

    const player = initPlayer(physics);
    const footsteps = initFootsteps();
    const input = initInput(renderer.domElement, () => unlockFootsteps(footsteps));

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, camera, renderer, physics, player, footsteps, input };
}

type State = Awaited<ReturnType<typeof init>>;

function update(state: State, dt: number) {
    updatePlayer(state.player, state.physics, state.input, dt);
    updatePhysics(state.physics, dt);
    updateFootsteps(state.footsteps, state.player.moved, isGrounded(state.player));
    applyPlayerCamera(state.player, state.camera);
    document.getElementById('hint')?.classList.toggle('hidden', state.input.locked);
    state.renderer.render(state.scene, state.camera);
}

async function start() {
    const state = await init();
    let last = performance.now();
    let frames = 0;
    state.renderer.setAnimationLoop(() => {
        const now = performance.now();
        update(state, Math.min((now - last) / 1000, MAX_DT));
        last = now;
        // Past the first frames' shader compiles.
        if (++frames === 3) document.getElementById('loading')?.classList.add('hidden');
    });
}

start();
