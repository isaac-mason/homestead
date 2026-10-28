export type Input = {
    keys: Set<string>;
    /** Mouse movement since the last frame, while pointer-locked. */
    look: [number, number];
    locked: boolean;
};

export function initInput(canvas: HTMLCanvasElement, onFirstClick: () => void): Input {
    const input: Input = { keys: new Set(), look: [0, 0], locked: false };

    canvas.addEventListener('click', () => {
        onFirstClick();
        canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
        input.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (event) => {
        if (!input.locked) return;
        input.look[0] += event.movementX;
        input.look[1] += event.movementY;
    });
    window.addEventListener('keydown', (event) => input.keys.add(event.code));
    window.addEventListener('keyup', (event) => input.keys.delete(event.code));
    window.addEventListener('blur', () => input.keys.clear());

    return input;
}

export function isHeld(input: Input, ...codes: string[]): boolean {
    return codes.some((code) => input.keys.has(code));
}

export function consumeLook(input: Input): [number, number] {
    const look: [number, number] = [input.look[0], input.look[1]];
    input.look[0] = 0;
    input.look[1] = 0;
    return look;
}
