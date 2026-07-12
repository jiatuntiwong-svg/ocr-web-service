"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface UsePanZoomOpts {
    zoom: number;
    setZoom: (z: number) => void;
    min?: number;
    max?: number;
    /** wheel step per scroll event (zoom delta per unit wheel) */
    wheelStep?: number;
    /** double-click resets to this value */
    resetTo?: number;
}

/**
 * Click-drag pan + Ctrl/Cmd-wheel zoom + double-click reset + Spacebar visual hint.
 *
 * Returns refs/handlers to spread onto the scrollable container. The container
 * MUST have `overflow: auto` (or `scroll`) so scrollLeft/scrollTop respond to
 * dragging. Replaced children (iframe, img, canvas) inside the container don't
 * bubble mousedown reliably across iframe boundaries — set `pointer-events: none`
 * on those children so the container receives the drag start.
 */
export function usePanZoom({
    zoom,
    setZoom,
    min = 0.5,
    max = 3,
    wheelStep = 0.1,
    resetTo = 1,
}: UsePanZoomOpts) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [spaceHeld, setSpaceHeld] = useState(false);

    const clamp = useCallback(
        (v: number) => Math.max(min, Math.min(max, +v.toFixed(3))),
        [min, max],
    );

    // ── Pan: mousedown → record start → move tracks delta → up clears ──
    const onMouseDown = useCallback((e: React.MouseEvent) => {
        // Only left button; don't hijack right-click / middle-click.
        if (e.button !== 0) return;
        const el = containerRef.current;
        if (!el) return;
        dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
        setIsDragging(true);
    }, []);

    const onMouseMove = useCallback((e: React.MouseEvent) => {
        if (!dragRef.current) return;
        const el = containerRef.current;
        if (!el) return;
        el.scrollLeft = dragRef.current.sl - (e.clientX - dragRef.current.x);
        el.scrollTop = dragRef.current.st - (e.clientY - dragRef.current.y);
    }, []);

    const stop = useCallback(() => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setIsDragging(false);
    }, []);

    // ── Wheel zoom: Ctrl/Cmd + scroll. Without modifier, normal scroll wins. ──
    // Native wheel listener so we can preventDefault — React's onWheel is passive.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : -1;
            setZoom(clamp(zoom + dir * wheelStep));
        };
        el.addEventListener("wheel", handler, { passive: false });
        return () => el.removeEventListener("wheel", handler);
    }, [zoom, setZoom, clamp, wheelStep]);

    // ── Double-click resets zoom. Ignored mid-drag (drag end isn't a dblclick). ──
    const onDoubleClick = useCallback(() => {
        setZoom(resetTo);
    }, [setZoom, resetTo]);

    // ── Spacebar = pan-mode visual hint (cursor: grab). Drag works either way. ──
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.code !== "Space") return;
            // Don't steal space from inputs (filename rename, search, etc).
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            setSpaceHeld(true);
        };
        const up = (e: KeyboardEvent) => {
            if (e.code === "Space") setSpaceHeld(false);
        };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
        };
    }, []);

    const cursor = isDragging ? "grabbing" : spaceHeld ? "grab" : "grab";

    const containerProps = {
        ref: containerRef,
        onMouseDown,
        onMouseMove,
        onMouseUp: stop,
        onMouseLeave: stop,
        onDoubleClick,
        style: {
            cursor,
            userSelect: isDragging ? ("none" as const) : ("auto" as const),
        },
    };

    return { containerRef, containerProps, isDragging, spaceHeld };
}
