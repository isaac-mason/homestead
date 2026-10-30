import { createRenderer, GpuArrays, loadSplats, SplatCollection, SplatRenderer } from '@sparkjsdev/radix';
import * as THREE from 'three';
import kitchenUrl from '../assets/kitchen.spz?url';
import colliderUrl from '../assets/kitchen-collider.glb?url';
import { initDebug, updateDebug } from './debug';
import { initDust, updateDust } from './dust';
import { initFocus, updateFocus } from './focus';
import { initFootsteps, unlockFootsteps, updateFootsteps } from './footsteps';
import { initInput, updateInput } from './input';
import { finishLoader, initLoader, setLoaderProgress, setLoaderStage } from './loader';
import { initPhysics, loadCollider, updatePhysics } from './physics';
import { applyPlayerCamera, initPlayer, updatePlayer, zoomAmount } from './player';
import { initPrep, unlockPrep, updatePrep } from './prep';
import { initTitle, renderTitle, updateTitle } from './title';
import './style.css';

const MAX_DT = 1 / 30;
const MAX_PIXEL_RATIO = 1.5;

async function init() {
    const loader = initLoader();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const physics = initPhysics();
    const [data] = await Promise.all([
        loadSplats(kitchenUrl, { onProgress: (fraction, stage) => setLoaderStage(loader, fraction, stage) }),
        loadCollider(physics, colliderUrl),
    ]);
    const kitchen = SplatCollection.arrays(GpuArrays.fromData(renderer, data));
    const dust = initDust();
    console.log(`homestead: ${dust.count.toLocaleString()} dust motes`);

    const prep = initPrep();
    const splats = new SplatRenderer({ renderer, collection: new SplatCollection([kitchen, dust.object, ...prep.objects]) });
    splats.raycast = () => {};
    scene.add(splats);

    const player = initPlayer(physics);
    const focus = initFocus(splats);
    const footsteps = initFootsteps();
    const debug = initDebug(scene, physics, player);
    const vignette = document.getElementById('vignette') as HTMLDivElement;
    const input = initInput(renderer.domElement, () => {
        unlockFootsteps(footsteps);
        unlockPrep(prep);
    });
    applyPlayerCamera(player, camera);
    const title = await initTitle(scene, camera, physics);
    setLoaderProgress(loader, 0.95);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        splats,
        dust,
        prep,
        physics,
        player,
        focus,
        footsteps,
        input,
        debug,
        vignette,
        title,
        loader,
    };
}

type State = Awaited<ReturnType<typeof init>>;

function update(state: State, dt: number) {
    updateInput(state.input);
    if (state.title.entered) updatePlayer(state.player, state.physics, state.input, dt);
    updatePhysics(state.physics, dt);
    updateFootsteps(state.footsteps, state.player.stepped, state.player.landed);
    applyPlayerCamera(state.player, state.camera);
    updateTitle(state.title, state.input.active, state.camera, dt);
    updateFocus(state.focus, state.physics, state.camera, state.splats, dt, !state.title.entered);
    updateDust(state.dust, state.camera, dt);
    if (state.title.entered) updatePrep(state.prep, state.input.keys, state.camera, dt);

    // the WebGL2 backend's CPU sort only runs when asked, and the dust never stops
    if (state.splats.sortMode === 'cpu') state.splats.requestSort();

    document.body.classList.toggle('active', state.input.active);
    state.vignette.style.opacity = zoomAmount(state.player).toFixed(3);
    updateDebug(state.debug, state.player, state.focus, state.splats, dt);
    renderTitle();
    state.renderer.render(state.scene, state.camera);
}

async function start() {
    const state = await init();
    applyPlayerCamera(state.player, state.camera);
    state.splats.prepare(state.camera);
    renderTitle();
    await state.renderer.compileAsync(state.scene, state.camera);
    finishLoader(state.loader);

    let last = performance.now();
    state.renderer.setAnimationLoop(() => {
        const now = performance.now();
        update(state, Math.min((now - last) / 1000, MAX_DT));
        last = now;
    });
}

start();
