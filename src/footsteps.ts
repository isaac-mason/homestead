import footstep1Url from '../assets/sounds/wood_footstep.1.ogg?url';
import footstep2Url from '../assets/sounds/wood_footstep.2.ogg?url';

const FOOTSTEPS = { stride: 0.75, volume: 0.5, pitchJitter: 0.08 };

export type Footsteps = {
    context: AudioContext | null;
    clips: AudioBuffer[];
    walked: number;
    last: number;
};

export function initFootsteps(): Footsteps {
    return { context: null, clips: [], walked: 0, last: -1 };
}

/** Browsers only allow audio after a user gesture. */
export async function unlockFootsteps(footsteps: Footsteps): Promise<void> {
    if (footsteps.context) return;
    const context = new AudioContext();
    footsteps.context = context;
    footsteps.clips = await Promise.all(
        [footstep1Url, footstep2Url].map(async (url) => context.decodeAudioData(await (await fetch(url)).arrayBuffer())),
    );
}

export function updateFootsteps(footsteps: Footsteps, moved: number, grounded: boolean): void {
    const { context, clips } = footsteps;
    if (!grounded || !context || clips.length === 0) return;
    footsteps.walked += moved;
    if (footsteps.walked < FOOTSTEPS.stride) return;
    footsteps.walked = 0;

    // Never the same clip twice running.
    footsteps.last = (footsteps.last + 1 + Math.floor(Math.random() * (clips.length - 1))) % clips.length;
    const source = context.createBufferSource();
    source.buffer = clips[footsteps.last];
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * FOOTSTEPS.pitchJitter;
    const gain = context.createGain();
    gain.gain.value = FOOTSTEPS.volume;
    source.connect(gain).connect(context.destination);
    source.start();
}
