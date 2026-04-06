'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

// ── DS 6.0 Semantic Zones ─────────────────────────────────────────────────────
// Normalized bounding boxes [x, y, w, h] as fraction of image size.
// Calibrated for typical DS 6.0 frontal 3/4 and straight-on product shots.
export const AI_ZONES: {
    label: string;
    emoji: string;
    rect: [number, number, number, number]; // x, y, w, h (0–1)
    hint: string;
}[] = [
    { label: 'Keyboard', emoji: '🎹', rect: [0.0, 0.62, 1.0, 0.38], hint: 'Fix key layout: correct alternating 2-black-3-black groups, fix key proportions' },
    { label: 'Logo', emoji: '🏷', rect: [0.32, 0.44, 0.36, 0.18], hint: 'Redraw the DreamPlay logo accurately: circular yin-yang emblem + Dream/Play wordmark' },
    { label: 'Control Panel', emoji: '🎛', rect: [0.0, 0.28, 1.0, 0.36], hint: 'Fix control panel details: knobs, LCD screen, center dial, buttons' },
    { label: 'Knobs', emoji: '🔘', rect: [0.04, 0.30, 0.14, 0.22], hint: 'Fix the two round black rubber knobs (Sound + Volume) — same size, correct spacing' },
    { label: 'Center Dial', emoji: '⭕', rect: [0.42, 0.30, 0.18, 0.28], hint: 'Fix center dial: rubber black/white segments around perimeter with gold metallic center band' },
    { label: 'Buttons', emoji: '▦', rect: [0.62, 0.32, 0.20, 0.22], hint: 'Fix 6 rectangular rubber buttons (2×3 grid): 5 matte black, 1 gold metallic' },
    { label: 'Left Grill', emoji: '≡', rect: [0.01, 0.28, 0.08, 0.32], hint: 'Fix left speaker grill: straight parallel horizontal groove lines, matte black casing' },
    { label: 'Right Grill', emoji: '≡', rect: [0.91, 0.28, 0.08, 0.32], hint: 'Fix right speaker grill: mirror image of left — same groove count and depth' },
    { label: 'Background', emoji: '🌫', rect: [0.0, 0.0, 1.0, 0.55], hint: 'Change or fix the background: remove artifacts, adjust lighting, clean up environment' },
    { label: 'Body / Chassis', emoji: '📦', rect: [0.0, 0.28, 1.0, 0.72], hint: 'Fix piano body and casing: matte black finish, consistent material and lighting' },
];

interface MaskRect {
    x: number; y: number; w: number; h: number; // 0–1 normalized
}

interface MaskEditorProps {
    imageBase64: string;        // base64 WITHOUT data: prefix
    imageMimeType: string;
    modelId: string;
    formatLabel: string;
    onResult: (base64: string, mimeType: string) => void;
    onClose: () => void;
}

type TabMode = 'marquee' | 'zones' | 'magic';

function buildMaskPng(imgW: number, imgH: number, rect: MaskRect): string {
    const canvas = document.createElement('canvas');
    canvas.width = imgW;
    canvas.height = imgH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, imgW, imgH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(
        Math.round(rect.x * imgW),
        Math.round(rect.y * imgH),
        Math.round(rect.w * imgW),
        Math.round(rect.h * imgH),
    );
    // Strip the data:image/png;base64, prefix
    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export default function MaskEditor({ imageBase64: initialBase64, imageMimeType, modelId, formatLabel, onResult, onClose }: MaskEditorProps) {
    const [tab, setTab] = useState<TabMode>('marquee');
    const [mask, setMask] = useState<MaskRect | null>(null);
    const [selectedZone, setSelectedZone] = useState<typeof AI_ZONES[0] | null>(null);
    const [prompt, setPrompt] = useState('');
    const [magicDesc, setMagicDesc] = useState('');
    const [isDetecting, setIsDetecting] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    const [error, setError] = useState('');

    // ── Undo history ────────────────────────────────────────────────────────────
    // currentBase64 is the live image shown in the editor.
    // undoStack holds previous base64 snapshots (oldest first).
    const [currentBase64, setCurrentBase64] = useState(initialBase64);
    const [undoStack, setUndoStack] = useState<string[]>([]);

    function pushUndo(base64: string) {
        setUndoStack(prev => [...prev.slice(-19), base64]); // keep last 20
    }
    function handleUndo() {
        if (undoStack.length === 0) return;
        setCurrentBase64(undoStack[undoStack.length - 1]);
        setUndoStack(prev => prev.slice(0, -1));
    }

    // Canvas drag state
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const dragStart = useRef<{ x: number; y: number } | null>(null);
    const [imgNaturalSize, setImgNaturalSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });

    const dataUrl = `data:${imageMimeType};base64,${currentBase64}`;

    // Load image to get natural dimensions
    useEffect(() => {
        const img = new Image();
        img.onload = () => {
            setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            imgRef.current = img;
        };
        img.src = dataUrl;
    }, [dataUrl]);

    // Draw overlay on canvas
    const drawOverlay = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const activeMask = tab === 'zones' && selectedZone
            ? { x: selectedZone.rect[0], y: selectedZone.rect[1], w: selectedZone.rect[2], h: selectedZone.rect[3] }
            : mask;

        if (activeMask) {
            const { x, y, w, h } = activeMask;
            const cw = canvas.width, ch = canvas.height;

            // Dark overlay on non-selected area
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(0, 0, cw, ch);

            // Clear the selected region (show image underneath)
            ctx.clearRect(x * cw, y * ch, w * cw, h * ch);

            // Dashed border
            ctx.save();
            ctx.strokeStyle = '#facc15';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 3]);
            ctx.strokeRect(x * cw + 1, y * ch + 1, w * cw - 2, h * ch - 2);
            ctx.restore();

            // Label
            ctx.fillStyle = '#facc15';
            ctx.font = 'bold 11px Inter, sans-serif';
            const label = tab === 'zones' ? selectedZone?.label ?? '' : 'Custom';
            ctx.fillText(label, x * cw + 4, y * ch + 14);
        }
    }, [mask, selectedZone, tab]);

    useEffect(() => { drawOverlay(); }, [drawOverlay]);

    // Canvas mouse events (marquee mode)
    function getRelPos(e: React.MouseEvent<HTMLCanvasElement>) {
        const rect = canvasRef.current!.getBoundingClientRect();
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    }

    function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
        if (tab !== 'marquee') return;
        dragStart.current = getRelPos(e);
        setMask(null);
    }

    function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
        if (tab !== 'marquee' || !dragStart.current) return;
        const cur = getRelPos(e);
        const x = Math.min(dragStart.current.x, cur.x);
        const y = Math.min(dragStart.current.y, cur.y);
        const w = Math.abs(cur.x - dragStart.current.x);
        const h = Math.abs(cur.y - dragStart.current.y);
        if (w > 0.01 && h > 0.01) setMask({ x, y, w, h });
    }

    function onMouseUp() {
        dragStart.current = null;
    }

    // AI Zones tab: select zone
    function selectZone(zone: typeof AI_ZONES[0]) {
        setSelectedZone(zone);
        setPrompt(zone.hint);
        setMask(null);
    }

    // Magic Select tab: call API
    async function handleMagicSelect() {
        if (!magicDesc.trim()) return;
        setIsDetecting(true);
        setError('');
        try {
            const res = await fetch('/api/magic-select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageBase64: currentBase64, imageMimeType, description: magicDesc, modelId }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setMask({ x: data.x, y: data.y, w: data.w, h: data.h });
            setSelectedZone(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsDetecting(false);
        }
    }

    // Apply inpaint
    async function handleApply() {
        const activeMask = tab === 'zones' && selectedZone
            ? { x: selectedZone.rect[0], y: selectedZone.rect[1], w: selectedZone.rect[2], h: selectedZone.rect[3] }
            : mask;
        if (!activeMask || !prompt.trim()) return;

        setIsApplying(true);
        setError('');
        try {
            const maskBase64 = buildMaskPng(imgNaturalSize.w, imgNaturalSize.h, activeMask);
            let res: Response;
            try {
                res = await fetch('/api/inpaint', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        imageBase64: currentBase64,
                        imageMimeType,
                        maskBase64,
                        prompt: prompt.trim(),
                        modelId,
                        zoneLabel: tab === 'zones' ? selectedZone?.label : tab === 'magic' ? magicDesc : 'marquee',
                    }),
                });
            } catch {
                throw new Error('Server unreachable — make sure the dev server is running');
            }
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            // Push current image to undo stack before updating
            pushUndo(currentBase64);
            setCurrentBase64(data.base64);
            onResult(data.base64, data.mimeType);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsApplying(false);
        }
    }

    const activeMask = tab === 'zones' && selectedZone
        ? { x: selectedZone.rect[0], y: selectedZone.rect[1], w: selectedZone.rect[2], h: selectedZone.rect[3] }
        : mask;
    const canApply = !!activeMask && prompt.trim().length > 0;

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.95)',
            display: 'flex', flexDirection: 'column',
            backdropFilter: 'blur(8px)',
        }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>

            {/* ── Header ── */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.6rem 1rem',
                background: 'rgba(10,10,10,0.9)',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                flexShrink: 0,
            }}>
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.75rem', padding: '2px 8px' }}>✕ Close</button>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'rgba(255,255,255,0.8)', letterSpacing: '0.05em' }}>🎭 MASK &amp; FIX</span>
                <span style={{ fontSize: '0.65rem', opacity: 0.5 }}>{formatLabel} · {modelId}</span>
                {/* Undo button — only shown when there's history */}
                {undoStack.length > 0 && (
                    <button
                        onClick={handleUndo}
                        title={`Undo last fix (${undoStack.length} available)`}
                        style={{
                            marginLeft: 'auto', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
                            borderRadius: 4, color: 'rgba(255,255,255,0.75)', cursor: 'pointer',
                            fontSize: '0.65rem', fontWeight: 600, padding: '2px 10px',
                            display: 'flex', alignItems: 'center', gap: '0.35rem',
                        }}
                    >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 14 4 9 9 4"/>
                            <path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
                        </svg>
                        Undo ({undoStack.length})
                    </button>
                )}
            </div>

            {/* ── Body ── */}
            <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

                {/* Left: canvas */}
                <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', overflow: 'hidden' }}>
                    <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '100%' }}>
                        {/* Original image */}
                        <img
                            src={dataUrl}
                            alt="Inpaint target"
                            style={{ display: 'block', maxWidth: '100%', maxHeight: 'calc(100vh - 160px)', borderRadius: '4px', userSelect: 'none' }}
                            draggable={false}
                        />
                        {/* Canvas overlay */}
                        <canvas
                            ref={canvasRef}
                            width={800}
                            height={600}
                            style={{
                                position: 'absolute', inset: 0, width: '100%', height: '100%',
                                cursor: tab === 'marquee' ? 'crosshair' : 'default',
                                borderRadius: '4px',
                            }}
                            onMouseDown={onMouseDown}
                            onMouseMove={onMouseMove}
                            onMouseUp={onMouseUp}
                            onMouseLeave={onMouseUp}
                        />
                    </div>
                    {tab === 'marquee' && !mask && (
                        <div style={{
                            position: 'absolute', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)',
                            fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)',
                            background: 'rgba(0,0,0,0.6)', padding: '4px 10px', borderRadius: 4,
                        }}>Click and drag to draw a selection box</div>
                    )}
                </div>

                {/* Right: controls */}
                <div style={{
                    width: '300px', flexShrink: 0,
                    background: 'rgba(18,18,18,0.98)',
                    borderLeft: '1px solid rgba(255,255,255,0.07)',
                    display: 'flex', flexDirection: 'column',
                    overflowY: 'auto',
                }}>

                    {/* Tab bar */}
                    <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
                        {([
                            { id: 'marquee', label: '⬚ Marquee' },
                            { id: 'zones', label: '🎯 Zones' },
                            { id: 'magic', label: '✨ Magic' },
                        ] as { id: TabMode; label: string }[]).map(t => (
                            <button key={t.id} onClick={() => { setTab(t.id); setMask(null); setSelectedZone(null); }}
                                style={{
                                    flex: 1, padding: '0.5rem 0.25rem', border: 'none', background: 'none',
                                    color: tab === t.id ? '#facc15' : 'rgba(255,255,255,0.45)',
                                    borderBottom: tab === t.id ? '2px solid #facc15' : '2px solid transparent',
                                    fontSize: '0.62rem', fontWeight: tab === t.id ? 700 : 400,
                                    cursor: 'pointer', transition: 'all 0.15s',
                                }}>
                                {t.label}
                            </button>
                        ))}
                    </div>

                    <div style={{ padding: '0.75rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>

                        {/* ── Marquee tab ── */}
                        {tab === 'marquee' && (
                            <div>
                                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
                                    Draw a rectangle over the area to edit. The AI will fix only that region.
                                </div>
                                {mask && (
                                    <div style={{ marginTop: '0.5rem', fontSize: '0.6rem', color: '#4ade80' }}>
                                        ✓ Selection: {Math.round(mask.w * 100)}% × {Math.round(mask.h * 100)}%
                                        <button onClick={() => setMask(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#f87171', fontSize: '0.6rem', cursor: 'pointer' }}>Clear</button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── Zones tab ── */}
                        {tab === 'zones' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.25rem' }}>
                                    Click a zone to select it — calibrated for DS 6.0 anatomy.
                                </div>
                                {AI_ZONES.map(z => (
                                    <button key={z.label} onClick={() => selectZone(z)}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.4rem',
                                            padding: '0.35rem 0.5rem', border: 'none', borderRadius: 4,
                                            background: selectedZone?.label === z.label ? 'rgba(250,204,21,0.15)' : 'rgba(255,255,255,0.04)',
                                            outline: selectedZone?.label === z.label ? '1px solid #facc15' : '1px solid transparent',
                                            color: selectedZone?.label === z.label ? '#facc15' : 'rgba(255,255,255,0.75)',
                                            fontSize: '0.65rem', cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                                        }}>
                                        <span>{z.emoji}</span>
                                        <span>{z.label}</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* ── Magic Select tab ── */}
                        {tab === 'magic' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
                                    Describe the region — Gemini will detect its bounding box.
                                </div>
                                <input
                                    type="text"
                                    placeholder='e.g. "the DreamPlay logo" or "the black keys"'
                                    value={magicDesc}
                                    onChange={e => setMagicDesc(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleMagicSelect()}
                                    style={{
                                        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                                        borderRadius: 4, padding: '0.35rem 0.5rem', color: '#fff', fontSize: '0.65rem',
                                        outline: 'none',
                                    }}
                                />
                                <button onClick={handleMagicSelect} disabled={isDetecting || !magicDesc.trim()}
                                    style={{
                                        padding: '0.35rem 0.75rem', border: 'none', borderRadius: 4,
                                        background: isDetecting ? 'rgba(255,255,255,0.08)' : 'rgba(250,204,21,0.15)',
                                        color: '#facc15', fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer',
                                        opacity: !magicDesc.trim() ? 0.4 : 1,
                                    }}>
                                    {isDetecting ? '🔍 Detecting…' : '✨ Detect Region'}
                                </button>
                                {mask && tab === 'magic' && (
                                    <div style={{ fontSize: '0.6rem', color: '#4ade80' }}>
                                        ✓ Region detected &amp; highlighted
                                        <button onClick={() => { setMask(null); setMagicDesc(''); }} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#f87171', fontSize: '0.6rem', cursor: 'pointer' }}>Clear</button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── Prompt (shared) ── */}
                        <div style={{ marginTop: 'auto', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                            <label style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                Fix Instruction
                            </label>
                            <textarea
                                rows={4}
                                placeholder="Describe what to change in the selected region…"
                                value={prompt}
                                onChange={e => setPrompt(e.target.value)}
                                style={{
                                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: 4, padding: '0.4rem 0.5rem', color: '#fff', fontSize: '0.65rem',
                                    resize: 'vertical', outline: 'none', lineHeight: 1.5,
                                }}
                            />
                            {error && (
                                <div style={{ fontSize: '0.6rem', color: '#f87171', padding: '0.3rem', background: 'rgba(248,113,113,0.08)', borderRadius: 3 }}>
                                    ⚠ {error}
                                </div>
                            )}
                            <button onClick={handleApply} disabled={!canApply || isApplying}
                                style={{
                                    padding: '0.5rem 1rem', border: 'none', borderRadius: 4,
                                    background: canApply && !isApplying ? 'linear-gradient(135deg,#b8941a,#f0c040)' : 'rgba(255,255,255,0.06)',
                                    color: canApply && !isApplying ? '#000' : 'rgba(255,255,255,0.3)',
                                    fontSize: '0.7rem', fontWeight: 700, cursor: canApply && !isApplying ? 'pointer' : 'default',
                                    transition: 'all 0.15s',
                                }}>
                                {isApplying ? '⚡ Applying fix…' : '⚡ Apply Fix'}
                            </button>
                            {!activeMask && (
                                <div style={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>
                                    {tab === 'marquee' ? 'Draw a selection first' : tab === 'zones' ? 'Select a zone first' : 'Detect a region first'}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
