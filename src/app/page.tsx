'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { OUTPUT_FORMATS, MODEL_OPTIONS, CATEGORY_LABELS } from '@/lib/output-formats';
import { DEFAULT_BRAND_CONFIG, BRAND_STYLE_PRESETS } from '@/lib/brand-config';
import type { OutputFormat, ModelOption, GenerationJob, ReferenceFile, HistoryEntry, SavedOutput } from '@/types';
import MaskEditor from '@/components/MaskEditor';

function formatTime(ms: number) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const CATEGORIES = ['social', 'ads', 'website', 'shopify'] as const;

// ─── Culling types ─────────────────────────────────────────────────────────────
type StarRating = 0 | 1 | 2 | 3 | 4 | 5;
type FlagState = 'unflagged' | 'pick' | 'reject';
type LabelColor = 'none' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';

interface ImageMeta {
    stars: StarRating;
    flag: FlagState;
    label: LabelColor;
    comment: string;
}

const LABEL_COLORS: Record<LabelColor, string> = {
    none: 'rgba(255,255,255,0.1)', red: '#e74c3c', yellow: '#f39c12',
    green: '#27ae60', blue: '#3498db', purple: '#9b59b6',
};

const LABELS: LabelColor[] = ['none', 'red', 'yellow', 'green', 'blue', 'purple'];

// ─── Prompt Presets ─────────────────────────────────────────────────────────
// Structured for Gemini image models: positive/spatial/material language first,
// [CRITICAL] weight markers on hallucination-prone elements, grouped sections.
const PRESET_DS60_STARTER =
`[SUBJECT] DreamPlay DS 6.0 — 88-key digital piano. Luxury product photography, photorealistic, 8K detail.

[KEYBOARD — CRITICAL]
Exact 88-key layout. Black keys arranged in strict 2-key group / gap / 3-key group / gap repeating pattern across the full width. White keys are regular, uniform, evenly spaced. Reproduce the exact key count and grouping from the reference image.

[CONTROL PANEL — follow reference exactly]
- Top-left: two identical round flat-top knobs (Sound + Volume), matte black rubber, same size, same gap between them
- Center: rectangular LCD display screen, exact size and position from reference, no added text or graphics
- Center: large circular dial, patterned rubber surface (alternating black/white sections), gold metallic outer ring
- Right of LCD: exactly six rectangular rubber buttons in a row, matching reference shapes and spacing; one gold metallic accent button

[LOGO — CRITICAL]
DreamPlay wordmark logo, exact letterforms from reference. White logo on dark backgrounds. Black logo on light backgrounds. Centered below control panel. Do not alter, distort, or invent characters.

[SPEAKER GRILLS — follow reference exactly]
Left and right sides of the chassis: clean, evenly-spaced horizontal line grooves (not dots, not mesh, not organic). Both sides identical. Matte black housing.

[LIGHTING & PHOTOGRAPHY]
Cinematic studio lighting, soft key light from upper-left, subtle fill, controlled specular highlights on surfaces. Dark gradient or solid dark background. Shallow depth of field, subject in crisp focus.

[MATERIALS]
Chassis: matte black ABS. White keys: gloss ivory. Black keys: matte black. Logo: metallic or printed. Knobs: flat-top matte rubber. Dial outer ring: gold polished metal. Buttons: satin rubber with one gold metallic.`;

const PRESET_NEGATIVE_GUARD =
`[ACCURACY CONSTRAINTS — apply to every element]

[KEYBOARD] The black keys MUST follow the 2-gap-3-gap repeating grouping. A piano where all black keys are evenly spaced across the keyboard is WRONG. Reference the uploaded image for exact layout.

[LOGO] Reproduce the DreamPlay logo exactly. Do not invent new letter shapes, do not add taglines, do not resize or reposition, do not substitute a different wordmark.

[KNOBS] The two top-left knobs are identical — same diameter, same height, same material, same gap. Do not add more knobs, do not change their shape to domed or spike-style.

[LCD] The LCD display maintains its exact rectangular dimensions and position. Do not add new labels, do not show user interface graphics, do not resize.

[CENTER DIAL] The large dial has a patterned rubber face (alternating black/white arc segments) with a gold metallic outer ring. Do not simplify to a plain circle. Do not change materials.

[6 BUTTONS] The six rectangular rubber buttons stay in their exact configuration and shapes. Do not add or remove buttons. One is gold metallic — the rest match the housing color.

[SPEAKER GRILLS] Both speaker grills are parallel horizontal grooves — not hexagonal mesh, not circular perforations, not organic texture. Keep them symmetrical and identical left-to-right.

[GEOMETRY] Do not warp, stretch, foreshorten, or distort the keyboard body. Maintain true proportions matching the reference image.`;


const FLAG_ICONS: Record<FlagState, string> = {
    pick: '⚑', unflagged: '⚐', reject: '✕',
};

// ─── localStorage helpers ──────────────────────────────────────────────────────
const META_KEY = 'dreamplay-image-meta';
function loadMeta(): Record<string, ImageMeta> {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
}
function saveMeta(meta: Record<string, ImageMeta>) {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { }
}

const DEFAULT_META: ImageMeta = { stars: 0, flag: 'unflagged', label: 'none', comment: '' };

const HISTORY_KEY = 'dreamplay-gen-history';
const MAX_HISTORY = 50;
function loadHistory(): HistoryEntry[] {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(entries: HistoryEntry[]) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY))); } catch { }
}
function addHistoryEntry(entry: HistoryEntry) {
    const existing = loadHistory().filter(e => e.id !== entry.id);
    saveHistory([entry, ...existing]);
}
function deleteHistoryEntry(id: string) {
    saveHistory(loadHistory().filter(e => e.id !== id));
}

// ─── Video helpers ─────────────────────────────────────────────────────────────
const VIDEO_EXTS = /\.(mp4|mov|webm|avi|mkv|m4v)$/i;
const isVideoFile = (path: string) => VIDEO_EXTS.test(path);
function fmtDuration(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ─── Feedback ──────────────────────────────────────────────────────────────────
const FEEDBACK_ISSUES = ['Wrong keyboard layout', 'Wrong key count', 'Logo missing/wrong', 'Wrong color/finish', 'Geometry issues', 'Hallucinated elements', 'Poor quality', 'Other'];
const POSITIVE_QUALITIES = [
    'Moody lighting', 'Studio lighting', 'Dark reflections', 'Warm glow / golden hour',
    'Premium feel', 'Clean product lines', 'Accurate keyboard', 'Logo looks great',
    'Color palette', 'Background / environment', 'Camera angle', 'Dramatic shadows',
    'Material textures', 'Water / surface reflections', 'Cinematic depth of field', 'Other',
];

// ── Product Spec Configurator ──────────────────────────────────────────
const PRODUCT_SPECS: { group: string; key: string; options: string[] }[] = [
    // Shot
    { group: 'Camera angle', key: 'angle', options: ['Retain from ref', '3/4 view', 'Side profile', 'Top down', 'Front', 'Back'] },
    { group: 'Crop', key: 'crop', options: ['Close up', 'Full product', 'Wide', 'Far'] },
    // Piano
    { group: 'Model', key: 'model', options: ['DS 5.5', 'DS 6.0', 'DS 6.5'] },
    { group: 'Keys', key: 'numKeys', options: ['61 keys', '76 keys', '88 keys'] },
    { group: 'Body color', key: 'bodyColor', options: ['Black', 'White', 'Gold'] },
    { group: 'Body material', key: 'bodyMaterial', options: ['Matte', 'Gloss'] },
    // Black keys
    { group: 'Black key color', key: 'blackKeyColor', options: ['Black', 'White', 'Gold'] },
    { group: 'Black key material', key: 'blackKeyMaterial', options: ['Gloss', 'Matte'] },
    // White keys
    { group: 'White key color', key: 'whiteKeyColor', options: ['White', 'Black', 'Gold'] },
    { group: 'White key material', key: 'whiteKeyMaterial', options: ['Gloss', 'Matte'] },
    // Components
    { group: 'Logo color', key: 'logoColor', options: ['White', 'Black', 'Gold'] },
    { group: 'Knobs color', key: 'knobsColor', options: ['Black', 'White', 'Gold'] },
    { group: 'Knobs material', key: 'knobsMaterial', options: ['Metal', 'Plastic'] },
    { group: 'Center dial color', key: 'dialColor', options: ['Black', 'White', 'Gold'] },
    { group: 'Center dial material', key: 'dialMaterial', options: ['Metal', 'Premium rubber'] },
    { group: 'Buttons color', key: 'buttonsColor', options: ['Black', 'White', 'Gold'] },
    { group: 'Buttons material', key: 'buttonsMaterial', options: ['Metal', 'Premium rubber'] },
    // Background
    { group: 'Background color', key: 'bgColor', options: ['Black', 'White', 'Gold'] },
    { group: 'Background style', key: 'bgStyle', options: ['Drop shadow', 'Reflective', 'High-end product lighting pop'] },
];

// ─── Thumbnail helper ─────────────────────────────────────────────────────────
// Routes product images through /api/thumb which caches resized WebP permanently.
// After first generation the browser never re-requests this URL (immutable header).
function thumbUrl(path: string, w = 320): string {
    return `/api/thumb?path=${encodeURIComponent(path)}&w=${w}`;
}

export default function HomePage() {
    // ─── Core state ───────────────────────────────────────────────────────────────

    const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
    const [selectedModel, setSelectedModel] = useState<string>('gemini-flash-image-31');  // Gemini 3.1 Flash (default)
    const [prompt, setPrompt] = useState('');
    const [enhancedPrompt, setEnhancedPrompt] = useState('');
    const [isEnhancing, setIsEnhancing] = useState(false);
    const [brandTags, setBrandTags] = useState<string[]>(DEFAULT_BRAND_CONFIG.styleWords);
    const [activeBrandTags, setActiveBrandTags] = useState<Set<string>>(new Set(DEFAULT_BRAND_CONFIG.styleWords));
    const [useBrandStyle, setUseBrandStyle] = useState<boolean>(true);

    // ── Prompt preset toggles ───────────────────────────────────
    const [useStarterPreset, setUseStarterPreset] = useState(false);
    const [useNegativeGuard, setUseNegativeGuard] = useState(false);

    // ── Product spec configurator ───────────────────────────────
    const [productSpecs, setProductSpecs] = useState<Record<string, string>>({
        angle: '3/4 view',
        crop: 'Full product',
        model: 'DS 6.0',
        numKeys: '88 keys',
        bodyColor: 'Black',
        bodyMaterial: 'Gloss',
        blackKeyColor: 'Black',
        blackKeyMaterial: 'Gloss',
        whiteKeyColor: 'Black',
        whiteKeyMaterial: 'Gloss',
        logoColor: 'White',
        knobsColor: 'Black',
        knobsMaterial: 'Metal',
        dialColor: 'Black',
        dialMaterial: 'Metal',
        buttonsColor: 'Black',
        buttonsMaterial: 'Premium rubber',
    });
    const setSpec = (key: string, value: string) =>
        setProductSpecs(prev => prev[key] === value ? { ...prev, [key]: '' } : { ...prev, [key]: value });

    // Expand ambiguous labels into precise prompt directives for Gemini
    const SPEC_EXPANSIONS: Record<string, string> = {
        'Retain from ref': 'CRITICAL — retain the EXACT same camera angle and perspective as shown in the reference image. Do not change the viewpoint, tilt, or framing in any way. Match the reference shot precisely.',
        '3/4 view': 'Three-quarter angle — camera at 45° to the front-left of the product, showing the full front face and left side panel simultaneously (standard hero product shot)',
        'Side profile': 'Pure side profile — camera perfectly perpendicular to the left side, only the side panel visible',
        'Top down': 'Flat lay / top-down — camera directly overhead looking straight down at the product',
        'Front': 'Straight-on front view — camera centered directly in front, perfectly symmetrical, front face only',
        'Back': 'Rear view — camera directly behind showing the back panel only',
        'Close up': 'Tight close-up — frame only a specific detail or section, high magnification',
        'Full product': 'Full product shot — the entire instrument fits within the frame with breathing room',
        'Wide': 'Wide shot — product occupies ~55% of frame, environment and background visible',
        'Far': 'Distant / environmental — product is small in frame, wide environment dominates',
        // Background styles
        'Drop shadow': 'Clean studio background with a soft, natural drop shadow directly beneath and behind the product — minimalist, crisp, white or dark seamless backdrop',
        'Reflective': 'Glossy reflective surface below the product — the piano reflects perfectly on a polished floor or table surface, creating a symmetrical mirror-like reflection beneath it',
        'High-end product lighting pop': 'Dynamic studio lighting with volumetric light rays, dramatic backlight rim glow, and cinematic atmosphere — think Apple or Bang & Olufsen launch campaign photography',
    };
    const buildSpecSuffix = () => {
        const lines = PRODUCT_SPECS
            .filter(s => productSpecs[s.key])
            .map(s => `${s.group}: ${SPEC_EXPANSIONS[productSpecs[s.key]] ?? productSpecs[s.key]}`);
        return lines.length ? `\n\nPRODUCT SPECS (follow strictly):\n${lines.join('\n')}` : '';
    };

    // Hydrate from localStorage after first mount (avoids SSR hydration mismatch)
    useEffect(() => {
        const m = localStorage.getItem('dp_model');
        if (m) setSelectedModel(m);
        const p = localStorage.getItem('dp_prompt');
        if (p) setPrompt(p);
        const ep = localStorage.getItem('dp_enhanced_prompt');
        if (ep) setEnhancedPrompt(ep);
        const bs = localStorage.getItem('dp_brand_style');
        if (bs !== null) setUseBrandStyle(bs !== 'off');
        // Preset toggles
        const starter = localStorage.getItem('dp_preset_starter');
        if (starter === 'on') setUseStarterPreset(true);
        const guard = localStorage.getItem('dp_preset_guard');
        if (guard === 'on') setUseNegativeGuard(true);
        // Product specs
        const specs = localStorage.getItem('dp_product_specs');
        if (specs) { try { setProductSpecs(JSON.parse(specs)); } catch { /* ignore */ } }
        // Selected formats
        const fmts = localStorage.getItem('dp_selected_formats');
        if (fmts) { try { setSelectedFormats(new Set(JSON.parse(fmts))); } catch { /* ignore */ } }
    }, []);
    useEffect(() => { localStorage.setItem('dp_brand_style', useBrandStyle ? 'on' : 'off'); }, [useBrandStyle]);
    useEffect(() => { localStorage.setItem('dp_preset_starter', useStarterPreset ? 'on' : 'off'); }, [useStarterPreset]);
    useEffect(() => { localStorage.setItem('dp_preset_guard', useNegativeGuard ? 'on' : 'off'); }, [useNegativeGuard]);
    useEffect(() => { localStorage.setItem('dp_product_specs', JSON.stringify(productSpecs)); }, [productSpecs]);
    useEffect(() => { localStorage.setItem('dp_selected_formats', JSON.stringify(Array.from(selectedFormats))); }, [selectedFormats]);

    // Brand suffix — only computed when on
    const brandSuffix = useBrandStyle
        ? `Style: ${Array.from(activeBrandTags).join(', ')}. Colors: ${DEFAULT_BRAND_CONFIG.colors.join(', ')}. ${DEFAULT_BRAND_CONFIG.customPromptSuffix}`
        : undefined;

    // ─── Video durations (lazy loaded) ────────────────────────────────────────────
    const [videoDurations, setVideoDurations] = useState<Record<string, string>>({});
    const handleVideoMeta = (path: string, e: React.SyntheticEvent<HTMLVideoElement>) => {
        const dur = (e.target as HTMLVideoElement).duration;
        if (dur && isFinite(dur)) setVideoDurations(prev => ({ ...prev, [path]: fmtDuration(dur) }));
    };

    const [rightSections, setRightSections] = useState<Set<string>>(new Set(['model', 'formats', 'prompt', 'specs']));

    // ─── Feedback state ───────────────────────────────────────────────────
    const [fbJob, setFbJob] = useState<GenerationJob | null>(null);
    const [fbIssues, setFbIssues] = useState<string[]>([]);
    const [fbNote, setFbNote] = useState('');
    const [fbSubmitting, setFbSubmitting] = useState(false);
    const openFeedback = (job: GenerationJob, e: React.MouseEvent) => { e.stopPropagation(); setFbJob(job); setFbIssues([]); setFbNote(''); };
    const closeFeedback = () => setFbJob(null);
    const toggleIssue = (issue: string) => setFbIssues(prev => prev.includes(issue) ? prev.filter(i => i !== issue) : [...prev, issue]);

    // ── Positive feedback loop ───────────────────────────────────────
    const [posJob, setPosJob] = useState<GenerationJob | null>(null);
    const [posQualities, setPosQualities] = useState<string[]>([]);
    const [posNote, setPosNote] = useState('');
    const [posSubmitting, setPosSubmitting] = useState(false);
    const openPositiveFeedback = (job: GenerationJob, e: React.MouseEvent) => {
        e.stopPropagation();
        rateJob(job.id, 'good');
        fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: job.id, modelId: job.modelId, prompt: job.prompt, formatLabel: job.formatLabel, issues: [], rating: 'good' }) }).catch(() => {});
        setPosJob(job); setPosQualities([]); setPosNote('');
    };
    const closePosModal = () => setPosJob(null);
    const toggleQuality = (q: string) => setPosQualities(prev => prev.includes(q) ? prev.filter(x => x !== q) : [...prev, q]);

    const submitPositiveFeedback = async () => {
        if (!posJob) return;
        setPosSubmitting(true);
        // Log positive feedback with selected qualities
        await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: posJob.id, modelId: posJob.modelId, prompt: posJob.prompt,
                formatLabel: posJob.formatLabel, qualities: posQualities, note: posNote, rating: 'good' }) }).catch(() => {});

        // Build amplification suffix from selected qualities
        const amplifications: string[] = [];
        if (posQualities.some(q => q.includes('light'))) amplifications.push('AMPLIFY: Push the lighting further — more dramatic, cinematic, mood-enhancing.');
        if (posQualities.includes('Dark reflections') || posQualities.includes('Water / surface reflections')) amplifications.push('AMPLIFY: Enhance surface reflections and glossy material interplay.');
        if (posQualities.includes('Premium feel')) amplifications.push('AMPLIFY: Push the luxury and premium aesthetic to the maximum — tactile materials, refined details.');
        if (posQualities.includes('Clean product lines')) amplifications.push('KEEP: Maintain the sharp, clean product geometry exactly as rendered.');
        if (posQualities.includes('Color palette')) amplifications.push('AMPLIFY: Deepen and saturate the color palette while maintaining brand accuracy.');
        if (posQualities.includes('Background / environment')) amplifications.push('AMPLIFY: Enhance the background environment with more depth and atmosphere.');
        if (posQualities.includes('Camera angle')) amplifications.push('KEEP: Maintain the same camera angle and perspective.');
        if (posQualities.includes('Dramatic shadows')) amplifications.push('AMPLIFY: Deepen the shadow contrast for even more dramatic impact.');
        if (posQualities.includes('Material textures')) amplifications.push('AMPLIFY: Enhance material surface detail — grain, gloss, matte transitions.');
        if (posQualities.includes('Cinematic depth of field')) amplifications.push('AMPLIFY: Increase bokeh and depth separation while keeping the subject tack sharp.');
        if (posNote) amplifications.push(`User direction: ${posNote}`);

        const suffix = amplifications.length
            ? `\n\n[POSITIVE ITERATION — Build on the previous success: ${amplifications.join(' ')}]`
            : `\n\n[POSITIVE ITERATION — Generate a refined variation that improves on all aspects of the previous result.]`;

        const fmt = OUTPUT_FORMATS.find(f => f.label === posJob.formatLabel);
        if (fmt) {
            const newJobId = `${Date.now()}-${Math.random()}`;
            const newJob: GenerationJob = {
                id: newJobId, batchId: `b-${Date.now()}`,
                formatId: fmt.id, formatLabel: fmt.label,
                modelId: posJob.modelId, modelName: posJob.modelName,
                status: 'processing', prompt: posJob.prompt + suffix,
                createdAt: Date.now(),
            };
            setJobs(prev => [newJob, ...prev]);
            try {
                let res: Response;
                try {
                    res = await fetch('/api/generate-image', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: newJob.prompt, modelId: newJob.modelId,
                            aspectRatio: fmt.aspectRatio, refImagePaths: selectedRefPaths, brandSuffix: brandSuffix ?? undefined }),
                    });
                } catch {
                    throw new Error('Server unreachable — make sure the dev server is running on port 3000');
                }
                const data = await res.json();
                const resultUrl = data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : undefined;
                if (resultUrl) {
                    setJobs(prev => prev.map(j => j.id === newJobId ? { ...j, status: 'done', resultUrl } : j));
                    setActiveStrip(newJobId);
                    saveGenerationToDisk(newJob, data.base64, data.mimeType || 'image/png', selectedRefPaths, brandSuffix);
                } else {
                    setJobs(prev => prev.map(j => j.id === newJobId ? { ...j, status: 'error', error: data.error || 'Failed' } : j));
                }
            } catch (err) {
                setJobs(prev => prev.map(j => j.id === newJobId ? { ...j, status: 'error', error: err instanceof Error ? err.message : String(err) } : j));
            }
        }
        setPosSubmitting(false);
        closePosModal();
    };
    const rateJob = (jobId: string, rating: 'good' | 'bad') =>
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, feedback: rating } : j));

    const submitFeedback = async (regenAfter: boolean) => {
        if (!fbJob) return;
        setFbSubmitting(true);
        rateJob(fbJob.id, 'bad');
        // Log to dedicated feedback API
        await fetch('/api/feedback', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId: fbJob.id, modelId: fbJob.modelId, prompt: fbJob.prompt,
                formatLabel: fbJob.formatLabel, issues: fbIssues, note: fbNote, rating: 'bad',
            }),
        }).catch(() => {});

        if (regenAfter) {
            // Build targeted correction suffix based on selected issues
            const corrections: string[] = [];
            if (fbIssues.some(i => i.includes('keyboard') || i.includes('key')))
                corrections.push('CRITICAL FIX: Ensure the exact 2-black-GAP-3-black-GAP piano keyboard pattern. Count every group carefully.');
            if (fbIssues.includes('Wrong color/finish'))
                corrections.push('CRITICAL: Use the correct DreamPlay brand colors — matte black chassis, gold/champagne logo, white keys.');
            if (fbIssues.includes('Logo missing/wrong'))
                corrections.push('The DreamPlay logo must be clearly visible and correctly placed on the product.');
            if (fbIssues.includes('Hallucinated elements'))
                corrections.push('Remove all invented elements. Only depict what is shown in the reference images.');
            if (fbIssues.includes('Geometry issues'))
                corrections.push('Correct the product geometry and proportions to match the reference exactly.');
            if (fbNote) corrections.push(`User note: ${fbNote}`);

            const correctionSuffix = corrections.length
                ? `\n\n[CORRECTION — PREVIOUS ATTEMPT FAILED: ${corrections.join(' ')}]`
                : '\n\n[CORRECTION — Please fix issues from the previous generation attempt.]';

            const fmt = OUTPUT_FORMATS.find(f => f.label === fbJob.formatLabel);
            if (fmt) {
                const newJobId = `${Date.now()}-${Math.random()}`;
                const newJob: GenerationJob = {
                    id: newJobId, batchId: `b-${Date.now()}`,
                    formatId: fmt.id, formatLabel: fmt.label,
                    modelId: fbJob.modelId, modelName: fbJob.modelName,
                    status: 'processing', prompt: fbJob.prompt + correctionSuffix,
                    createdAt: Date.now(),
                };
                setJobs(prev => [newJob, ...prev]);
                try {
                    let res: Response;
                    try {
                        res = await fetch('/api/generate-image', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                prompt: newJob.prompt, modelId: newJob.modelId,
                                aspectRatio: fmt.aspectRatio,
                                refImagePaths: selectedRefPaths,
                                brandSuffix: brandSuffix ?? undefined,
                            }),
                        });
                    } catch {
                        throw new Error('Server unreachable — make sure the dev server is running on port 3000');
                    }
                    const data = await res.json();
                    if (data.base64) {
                        const resultUrl = `data:${data.mimeType || 'image/png'};base64,${data.base64}`;
                        setJobs(prev => prev.map(j => j.id === newJobId
                            ? { ...j, status: 'done', resultUrl, completedAt: Date.now() } : j));
                    } else {
                        setJobs(prev => prev.map(j => j.id === newJobId
                            ? { ...j, status: 'error', error: data.error || 'No image' } : j));
                    }
                } catch (err) {
                    setJobs(prev => prev.map(j => j.id === newJobId
                        ? { ...j, status: 'error', error: err instanceof Error ? err.message : String(err) } : j));
                }
            }
        }
        setFbSubmitting(false);
        closeFeedback();
    };

    // ─── Panel resize state ────────────────────────────────────────────
    const [leftW, setLeftW] = useState(220);
    const [rightW, setRightW] = useState(270);
    const dragRef = useRef<{ which: 'left' | 'right'; startX: number; startW: number } | null>(null);
    const startPanelDrag = useCallback((which: 'left' | 'right', e: React.MouseEvent) => {
        e.preventDefault();
        const handle = e.currentTarget as HTMLElement;
        handle.classList.add('dragging');
        dragRef.current = { which, startX: e.clientX, startW: which === 'left' ? leftW : rightW };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const delta = ev.clientX - dragRef.current.startX;
            if (dragRef.current.which === 'left') {
                setLeftW(Math.max(140, Math.min(450, dragRef.current.startW + delta)));
            } else {
                setRightW(Math.max(180, Math.min(450, dragRef.current.startW - delta)));
            }
        };
        const onUp = () => {
            handle.classList.remove('dragging');
            if (dragRef.current) {
                localStorage.setItem('dp_left_w', String(leftW));
                localStorage.setItem('dp_right_w', String(rightW));
            }
            dragRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftW, rightW]);

    // ─── Index Library state ──────────────────────────────────────────
    const [indexing, setIndexing] = useState(false);
    const [indexMsg, setIndexMsg] = useState('');
    const runIndexLibrary = async () => {
        setIndexing(true); setIndexMsg('');
        try {
            const res = await fetch('/api/index-library', { method: 'POST' });
            const d = await res.json();
            setIndexMsg(d.ok ? `✓ Indexed ${d.indexed} files (${d.skipped} up to date)` : `Error: ${d.error}`);
            const lib = await fetch('/api/product-images').then(r => r.json());
            if (lib.grouped) setProductLibrary(lib.grouped);
        } catch (e) { setIndexMsg(String(e)); }
        setIndexing(false);
        setTimeout(() => setIndexMsg(''), 5000);
    };

    // ─── Product library ──────────────────────────────────────────────────────────
    const [productLibrary, setProductLibrary] = useState<Record<string, { path: string; name: string }[]>>({});
    const [isLoadingLibrary, setIsLoadingLibrary] = useState(true);
    const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
    const [showAllFolders, setShowAllFolders] = useState(true);

    // ─── References ───────────────────────────────────────────────────────────────
    const [selectedRefPaths, setSelectedRefPaths] = useState<string[]>([]);
    const [uploadedRefs, setUploadedRefs] = useState<ReferenceFile[]>([]);
    const [isDragOverRefs, setIsDragOverRefs] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ─── View state ───────────────────────────────────────────────────────────────
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const [activeStrip, setActiveStrip] = useState<string | null>(null);
    const [maskEditorJob, setMaskEditorJob] = useState<GenerationJob | null>(null);
    const [thumbSize, setThumbSize] = useState(90); // px for grid columns
    const [selectedGridImage, setSelectedGridImage] = useState<string | null>(null);
    const lastRefClickIdx = useRef<number>(-1); // for Shift+click range

    // ─── Pagination ───────────────────────────────────────────────────────────────
    const PAGE_SIZE = 75;
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const sentinelRef = useRef<HTMLDivElement>(null);

    // ─── Debounced thumb size (slider shows instant feedback, layout deferred) ────
    const [thumbSizeDisplay, setThumbSizeDisplay] = useState(thumbSize);
    const sliderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ─── Culling metadata ─────────────────────────────────────────────────────────
    const [imageMeta, setImageMeta] = useState<Record<string, ImageMeta>>({});
    useEffect(() => { setImageMeta(loadMeta()); }, []);

    const setMeta = (path: string, update: Partial<ImageMeta>) => {
        setImageMeta(prev => {
            const next = { ...prev, [path]: { ...(prev[path] || DEFAULT_META), ...update } };
            saveMeta(next);
            return next;
        });
    };

    const getMeta = useCallback((path: string): ImageMeta => imageMeta[path] || DEFAULT_META, [imageMeta]);

    // ─── Filter state ──────────────────────────────────────────────────────────────
    const [filterStars, setFilterStars] = useState<StarRating>(0);
    const [filterFlag, setFilterFlag] = useState<FlagState | 'all'>('all');
    const [filterLabel, setFilterLabel] = useState<LabelColor | 'all'>('all');

    // ─── Jobs (persisted to sessionStorage so clicks don't lose outputs) ──────
    const [jobs, setJobs] = useState<GenerationJob[]>(() => {
        if (typeof window === 'undefined') return [];
        try { return JSON.parse(sessionStorage.getItem('dp_jobs') || '[]'); } catch { return []; }
    });
    const [isGenerating, setIsGenerating] = useState(false);
    useEffect(() => {
        try {
            // Strip base64 image data before storing — blows the 5 MB sessionStorage quota.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const slim = jobs.map(({ resultUrl, resultBase64, ...rest }) => rest);
            sessionStorage.setItem('dp_jobs', JSON.stringify(slim));
        } catch { /* quota exceeded — skip persistence */ }
    }, [jobs]);


    // ─── Generation history ───────────────────────────────────────────────────────
    const [genHistory, setGenHistory] = useState<HistoryEntry[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [editingHistoryId, setEditingHistoryId] = useState<string | null>(null);
    const [editingPrompt, setEditingPrompt] = useState('');
    useEffect(() => { setGenHistory(loadHistory()); }, []);

    // ─── Reference tagging + priority funnel ─────────────────────────────────
    type RefRole = 'Product' | 'Talent' | 'Background';
    const REF_ROLES: RefRole[] = ['Product', 'Talent', 'Background'];
    const REF_ROLE_COLORS: Record<RefRole, string> = {
        Product: '#c9a84c', Talent: '#6a9ed4', Background: '#7dbd8a',
    };
    const [refTags, setRefTags] = useState<Map<string, RefRole>>(new Map());
    const [priorityOrder, setPriorityOrder] = useState<RefRole[]>(['Product', 'Talent', 'Background']);

    const cycleRefTag = (id: string) =>
        setRefTags(prev => {
            const next = new Map(prev);
            const current = prev.get(id);
            const idx = current ? REF_ROLES.indexOf(current) : -1;
            const nextRole = REF_ROLES[(idx + 1) % REF_ROLES.length];
            next.set(id, nextRole);
            return next;
        });

    const movePriority = (role: RefRole, dir: -1 | 1) =>
        setPriorityOrder(prev => {
            const idx = prev.indexOf(role);
            const next = [...prev];
            const to = idx + dir;
            if (to < 0 || to >= next.length) return prev;
            [next[idx], next[to]] = [next[to], next[idx]];
            return next;
        });

    // Build prompt suffix from priority order
    const prioritySuffix = useMemo(() => {
        const labels: Record<RefRole, string> = {
            Product: 'the product (piano/keyboard) is the primary subject — replicate its exact shape, branding, and keyboard layout',
            Talent: 'the person/talent is a supporting subject — match their appearance and pose from the reference',
            Background: 'the background/setting provides context and atmosphere only',
        };
        const ranked = priorityOrder.map((role, i) => `Priority ${i + 1} (${['HIGHEST', 'SECONDARY', 'LOWEST'][i]}): ${labels[role]}`);
        return ' Composition priorities: ' + ranked.join('. ') + '.';
    }, [priorityOrder]);

    // ─── Saved outputs ───────────────────────────────────────────────────────
    const [savedOutputs, setSavedOutputs] = useState<Record<string, SavedOutput[]>>({});
    const [showOutputs, setShowOutputs] = useState(true);  // auto-expanded
    const [selectedOutput, setSelectedOutput] = useState<SavedOutput | null>(null);

    const loadSavedOutputs = useCallback(async () => {
        try {
            const res = await fetch('/api/save-generation');
            const data = await res.json();
            if (data.dates) {
                const dates = data.dates as Record<string, SavedOutput[]>;
                setSavedOutputs(dates);

                // Restore disk generations into filmstrip as done jobs
                const diskJobs: GenerationJob[] = [];
                for (const dayItems of Object.values(dates)) {
                    for (const out of dayItems) {
                        diskJobs.push({
                            id: out.jobId || out.fileName,
                            batchId: `b-disk-${out.date}`,
                            formatId: out.formatLabel || 'saved',
                            formatLabel: out.formatLabel || 'Saved',
                            modelId: out.modelId || 'unknown',
                            modelName: out.modelName || 'Saved',
                            status: 'done',
                            resultUrl: out.path,   // public URL — works directly in <img>
                            prompt: out.prompt || '',
                            createdAt: out.createdAt || 0,
                        });
                    }
                }
                // Merge: keep in-session jobs (higher fidelity) and add disk jobs not already present
                setJobs(prev => {
                    const existingIds = new Set(prev.map(j => j.id));
                    const toAdd = diskJobs.filter(j => !existingIds.has(j.id));
                    return toAdd.length ? [...prev, ...toAdd] : prev;
                });
            }
        } catch { /* ignore */ }
    }, []);

    useEffect(() => { loadSavedOutputs(); }, [loadSavedOutputs]);

    const saveGenerationToDisk = useCallback(async (
        job: GenerationJob,
        base64: string,
        mimeType: string,
        refImagePaths: string[],
        brandSuffix: string | undefined,
    ) => {
        try {
            await fetch('/api/save-generation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    base64,
                    mimeType,
                    jobId: job.id.replace(/[^a-z0-9]/gi, '_'),
                    prompt: job.prompt,
                    enhancedPrompt: '',
                    modelId: job.modelId,
                    modelName: job.modelName,
                    formatLabel: job.formatLabel,
                    refImagePaths,
                    brandSuffix,
                    createdAt: job.createdAt,
                }),
            });
            loadSavedOutputs();
        } catch (e) { console.warn('[save-generation]', e); }
    }, [loadSavedOutputs]);

    // Persist prompt + model to localStorage
    useEffect(() => { localStorage.setItem('dp_prompt', prompt); }, [prompt]);
    useEffect(() => { localStorage.setItem('dp_enhanced_prompt', enhancedPrompt); }, [enhancedPrompt]);
    useEffect(() => { localStorage.setItem('dp_model', selectedModel); }, [selectedModel]);

    // ─── Load library ─────────────────────────────────────────────────────────────
    useEffect(() => {
        fetch('/api/product-images')
            .then(r => r.json())
            .then(data => {
                if (data.grouped) {
                    setProductLibrary(data.grouped);
                    // Default to All Photos — no folder auto-selected
                }
            })
            .catch(() => { })
            .finally(() => setIsLoadingLibrary(false));
    }, []);

    // ─── Memoized + paginated images ──────────────────────────────────────────────
    const allVisibleImages = useMemo(() => {
        let entries: { path: string; name: string; folder: string }[] = [];
        if (showAllFolders) {
            Object.entries(productLibrary).forEach(([folder, imgs]) =>
                imgs.forEach(img => entries.push({ ...img, folder }))
            );
        } else if (selectedFolder && productLibrary[selectedFolder]) {
            entries = productLibrary[selectedFolder].map(img => ({ ...img, folder: selectedFolder }));
        }
        return entries.filter(img => {
            const m = getMeta(img.path);
            if (filterStars > 0 && m.stars < filterStars) return false;
            if (filterFlag !== 'all' && m.flag !== filterFlag) return false;
            if (filterLabel !== 'all' && m.label !== filterLabel) return false;
            return true;
        });
    }, [productLibrary, showAllFolders, selectedFolder, filterStars, filterFlag, filterLabel, imageMeta]);

    // Reset pagination when source changes
    useEffect(() => setVisibleCount(PAGE_SIZE), [showAllFolders, selectedFolder, filterStars, filterFlag, filterLabel]);

    const visibleImages = allVisibleImages.slice(0, visibleCount);
    const hasMore = visibleCount < allVisibleImages.length;

    // Intersection observer for load-more sentinel
    useEffect(() => {
        if (!sentinelRef.current || !hasMore) return;
        const obs = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting) setVisibleCount(c => c + PAGE_SIZE);
        }, { rootMargin: '200px' });
        obs.observe(sentinelRef.current);
        return () => obs.disconnect();
    }, [hasMore, visibleImages.length]);

    // ─── Drag-and-drop to references ─────────────────────────────────────────────
    const handleDragStart = (e: React.DragEvent, path: string) => {
        e.dataTransfer.setData('imagePath', path);
        e.dataTransfer.effectAllowed = 'copy';
    };
    const handleDropOnRefs = (e: React.DragEvent) => {
        e.preventDefault(); setIsDragOverRefs(false);
        const path = e.dataTransfer.getData('imagePath');
        if (path && !selectedRefPaths.includes(path) && selectedRefPaths.length < 5)
            setSelectedRefPaths(prev => [...prev, path]);
    };
    const toggleRefSelection = (path: string) =>
        setSelectedRefPaths(prev => {
            if (prev.includes(path)) return prev.filter(p => p !== path);
            if (prev.length < 5) return [...prev, path];
            return prev;
        });

    const moveRef = (path: string, dir: -1 | 1) =>
        setSelectedRefPaths(prev => {
            const idx = prev.indexOf(path);
            if (idx < 0) return prev;
            const to = idx + dir;
            if (to < 0 || to >= prev.length) return prev;
            const next = [...prev];
            [next[idx], next[to]] = [next[to], next[idx]];
            return next;
        });

    // ─── Thumb click: Cmd=ref toggle · Shift=range ref · plain=cull select ────────
    const handleThumbClick = useCallback((e: React.MouseEvent, imgPath: string, idx: number) => {
        if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            setSelectedRefPaths(prev => {
                if (prev.includes(imgPath)) return prev.filter(p => p !== imgPath);
                if (prev.length < 5) return [...prev, imgPath];
                return prev;
            });
            lastRefClickIdx.current = idx;
        } else if (e.shiftKey && lastRefClickIdx.current >= 0) {
            e.preventDefault();
            const from = Math.min(lastRefClickIdx.current, idx);
            const to = Math.max(lastRefClickIdx.current, idx);
            setSelectedRefPaths(prev => {
                const adds = allVisibleImages.slice(from, to + 1).map(i => i.path).filter(p => !prev.includes(p));
                return [...prev, ...adds].slice(0, 5);
            });
        } else {
            setSelectedGridImage(prev => prev === imgPath ? null : imgPath);
            lastRefClickIdx.current = idx;
        }
    }, [allVisibleImages]);

    // ─── File upload ──────────────────────────────────────────────────────────────
    const handleFiles = useCallback((files: FileList) => {
        Array.from(files).forEach(file => {
            if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
            const reader = new FileReader();
            reader.onload = e => {
                const dataUrl = e.target?.result as string;
                setUploadedRefs(prev => [...prev, {
                    id: `${Date.now()}-${Math.random()}`, name: file.name,
                    type: file.type.startsWith('image/') ? 'image' : 'video', dataUrl, mimeType: file.type,
                }]);
            };
            reader.readAsDataURL(file);
        });
    }, []);

    // ─── Brand / prompt ───────────────────────────────────────────────────────────
    const toggleBrandTag = (tag: string) =>
        setActiveBrandTags(prev => { const n = new Set(prev); n.has(tag) ? n.delete(tag) : n.add(tag); return n; });

    const enhancePromptHandler = async () => {
        if (!prompt.trim()) return;
        setIsEnhancing(true);
        try {
            const brandContext = `${DEFAULT_BRAND_CONFIG.name}. Style: ${Array.from(activeBrandTags).join(', ')}. Colors: ${DEFAULT_BRAND_CONFIG.colors.join(', ')}. ${DEFAULT_BRAND_CONFIG.customPromptSuffix}`;
            const res = await fetch('/api/enhance-prompt', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, brandContext }),
            });
            const data = await res.json();
            if (data.enhanced) setEnhancedPrompt(data.enhanced);
        } catch { }
        setIsEnhancing(false);
    };

    // ─── Format toggles ───────────────────────────────────────────────────────────
    const toggleFormat = (id: string) =>
        setSelectedFormats(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

    const toggleAllInCategory = (cat: string) => {
        const ids = OUTPUT_FORMATS.filter(f => f.category === cat).map(f => f.id);
        const allOn = ids.every(id => selectedFormats.has(id));
        setSelectedFormats(prev => {
            const n = new Set(prev);
            allOn ? ids.forEach(id => n.delete(id)) : ids.forEach(id => n.add(id));
            return n;
        });
    };

    // ─── Generation ───────────────────────────────────────────────────────────────
    const startGeneration = async () => {
        const formats = OUTPUT_FORMATS.filter(f => selectedFormats.has(f.id));
        const model = MODEL_OPTIONS.find(m => m.id === selectedModel);
        if (!formats.length || !model) return;
        setIsGenerating(true); setActiveStrip(null);
        const batchId = `b-${Date.now()}`;
        const newJobs: GenerationJob[] = formats.map(fmt => ({
            id: `${Date.now()}-${Math.random()}`, batchId, formatId: fmt.id, formatLabel: fmt.label,
            modelId: model.apiModel, modelName: model.name, status: 'queued',
            prompt: enhancedPrompt || prompt, createdAt: Date.now(),
        }));
        setJobs(prev => [...newJobs, ...prev]);
        const basePrompt = enhancedPrompt || prompt;
        const presetPrefix = [
            useStarterPreset ? PRESET_DS60_STARTER : '',
            useNegativeGuard ? PRESET_NEGATIVE_GUARD : '',
        ].filter(Boolean).join('\n\n');
        const specSuffix = buildSpecSuffix();
        const activePrompt = (presetPrefix ? `${presetPrefix}\n\n${basePrompt}` : basePrompt) + specSuffix;
        const refImagePaths = selectedRefPaths.slice();

        // ── Save to history ──────────────────────────────────────────────────────
        const histEntry: HistoryEntry = {
            id: `h-${Date.now()}`,
            prompt,
            enhancedPrompt,
            refPaths: refImagePaths,
            uploadedRefNames: uploadedRefs.map(r => r.name),
            modelId: model.id,
            modelName: model.name,
            formatLabels: formats.map(f => f.label),
            createdAt: Date.now(),
        };
        addHistoryEntry(histEntry);
        setGenHistory(prev => [histEntry, ...prev.filter(e => e.id !== histEntry.id)].slice(0, MAX_HISTORY));

        for (const job of newJobs) {
            const fmt = OUTPUT_FORMATS.find(f => f.id === job.formatId)!;
            setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'processing' } : j));
            try {
                let res: Response;
                try {
                    res = await fetch(fmt.type === 'video' ? '/api/generate-video' : '/api/generate-image', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: activePrompt, modelId: job.modelId, aspectRatio: fmt.aspectRatio, width: fmt.width, height: fmt.height, refImagePaths, brandSuffix, prioritySuffix }),
                    });
                } catch {
                    throw new Error('Server unreachable — make sure the dev server is running on port 3000');
                }
                const data = await res.json();
                const resultUrl = data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : data.videoUrl || undefined;
                if (resultUrl || data.operationName) {
                    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'done', resultUrl, completedAt: Date.now() } : j));
                    if (data.base64) saveGenerationToDisk(job, data.base64, data.mimeType || 'image/png', refImagePaths, brandSuffix);
                } else { throw new Error(data.error || 'No result'); }
            } catch (err) {
                setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: err instanceof Error ? err.message : String(err) } : j));
            }
        }
        setIsGenerating(false);
    };

    // ─── Restore from history ────────────────────────────────────────────────────
    const restoreFromHistory = (entry: HistoryEntry) => {
        setPrompt(entry.prompt);
        setEnhancedPrompt(entry.enhancedPrompt);
        setSelectedRefPaths(entry.refPaths.slice());
        setSelectedModel(entry.modelId);
    };

    const reGenerateFromHistory = async (entry: HistoryEntry) => {
        // Restore state
        setPrompt(entry.prompt);
        setEnhancedPrompt(entry.enhancedPrompt);
        setSelectedRefPaths(entry.refPaths.slice());
        setSelectedModel(entry.modelId);
        // Then trigger generation with the entry's data directly
        const formats = OUTPUT_FORMATS.filter(f => entry.formatLabels.includes(f.label));
        // Match by id OR apiModel (for backward compat with older history entries)
        const model = MODEL_OPTIONS.find(m => m.id === entry.modelId || m.apiModel === entry.modelId)
            ?? MODEL_OPTIONS.find(m => m.id === 'gemini-flash-image'); // safe fallback
        if (!formats.length || !model) return;
        setIsGenerating(true); setActiveStrip(null);
        const activePrompt = entry.enhancedPrompt || entry.prompt;
        const batchId = `b-${Date.now()}`;
        const newJobs: GenerationJob[] = formats.map(fmt => ({
            id: `${Date.now()}-${Math.random()}`, batchId, formatId: fmt.id, formatLabel: fmt.label,
            modelId: model.apiModel, modelName: model.name, status: 'queued',
            prompt: activePrompt, createdAt: Date.now(),
        }));
        setJobs(prev => [...newJobs, ...prev]);
        for (const job of newJobs) {
            const fmt = OUTPUT_FORMATS.find(f => f.id === job.formatId)!;
            setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'processing' } : j));
            try {
                let res: Response;
                try {
                    res = await fetch(fmt.type === 'video' ? '/api/generate-video' : '/api/generate-image', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: activePrompt, modelId: job.modelId, aspectRatio: fmt.aspectRatio, refImagePaths: entry.refPaths, brandSuffix, prioritySuffix }),
                    });
                } catch {
                    throw new Error('Server unreachable — make sure the dev server is running on port 3000');
                }
                const data = await res.json();
                const resultUrl = data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : data.videoUrl || undefined;
                if (resultUrl || data.operationName) {
                    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'done', resultUrl, completedAt: Date.now() } : j));
                } else { throw new Error(data.error || 'No result'); }
            } catch (err) {
                setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: err instanceof Error ? err.message : String(err) } : j));
            }
        }
        setIsGenerating(false);
    };

    const saveHistoryEdit = (id: string, newPrompt: string) => {
        setGenHistory(prev => {
            const updated = prev.map(e => e.id === id ? { ...e, prompt: newPrompt, enhancedPrompt: '' } : e);
            saveHistory(updated);
            return updated;
        });
        setEditingHistoryId(null);
    };

    const toggleRightSection = (k: string) =>
        setRightSections(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

    const activeRefCount = selectedRefPaths.length + uploadedRefs.length;
    const currentPreviewJob = activeStrip ? jobs.find(j => j.id === activeStrip) : null;

    // ─── Delete from library ─────────────────────────────────────────────────────
    const deleteFromLibrary = useCallback(async (imgPath: string) => {
        const name = imgPath.split('/').pop();
        if (!confirm(`Permanently delete "${name}" from library?`)) return;
        try {
            const res = await fetch(`/api/product-images?path=${encodeURIComponent(imgPath)}`, { method: 'DELETE' });
            if (!res.ok) { const d = await res.json(); alert(d.error); return; }
            // Optimistic: remove from local state
            setProductLibrary(prev => {
                const next = { ...prev };
                for (const folder of Object.keys(next)) {
                    next[folder] = next[folder].filter(i => i.path !== imgPath);
                    if (next[folder].length === 0) delete next[folder];
                }
                return next;
            });
            setSelectedGridImage(null);
            setSelectedRefPaths(prev => prev.filter(p => p !== imgPath));
        } catch { alert('Delete failed'); }
    }, []);

    // ─── Keyboard shortcuts for culling ──────────────────────────────────────────────
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            // ESC — exit all preview modes
            if (e.key === 'Escape') {
                if (lightboxSrc) { setLightboxSrc(null); return; }
                if (activeStrip) { setActiveStrip(null); return; }
                if (previewImage) { setPreviewImage(null); return; }
            }
            if (!selectedGridImage) return;
            const n = Number(e.key);
            if (n >= 1 && n <= 5) setMeta(selectedGridImage, { stars: n as StarRating });
            if (e.key === '0') setMeta(selectedGridImage, { stars: 0 });
            if (e.key === 'z' || e.key === 'Z') setMeta(selectedGridImage, { flag: getMeta(selectedGridImage).flag === 'pick' ? 'unflagged' : 'pick' });
            if (e.key === 'x' || e.key === 'X') setMeta(selectedGridImage, { flag: getMeta(selectedGridImage).flag === 'reject' ? 'unflagged' : 'reject' });
            if (e.key === 'u' || e.key === 'U') setMeta(selectedGridImage, { flag: 'unflagged' });
            if (e.key === 'Enter') toggleRefSelection(selectedGridImage);
            // Cmd+Delete — permanently delete from library
            if ((e.key === 'Delete' || e.key === 'Backspace') && e.metaKey) {
                e.preventDefault();
                deleteFromLibrary(selectedGridImage);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [selectedGridImage, imageMeta, activeStrip, previewImage, lightboxSrc]);

    // ─── Render helpers ───────────────────────────────────────────────────────────
    const selectedImageMeta = selectedGridImage ? getMeta(selectedGridImage) : null;

    return (
        <div className="app-shell">
            {/* ── TOOLBAR ── */}
            <header className="toolbar">
                <div className="toolbar-left">
                    <div className="toolbar-logo">
                        <div className="logo-mark">🎹</div>
                        <div><div className="logo-text">DreamPlay</div><div className="logo-sub">Asset Generator</div></div>
                    </div>
                    <div className="toolbar-divider" />
                    <div className="api-status connected">
                        <span className="dot" />
                        API Ready
                    </div>
                </div>
                <div className="toolbar-center">
                    <div className="toolbar-breadcrumb">
                        <span>Library</span>
                        {!showAllFolders && selectedFolder && <><span className="sep">›</span><span className="current">{selectedFolder}</span></>}
                        {showAllFolders && <><span className="sep">›</span><span className="current">All Folders</span></>}
                        {(previewImage || currentPreviewJob) && <><span className="sep">›</span><span className="current">{currentPreviewJob ? currentPreviewJob.formatName : 'Preview'}</span></>}
                    </div>
                </div>
                <div className="toolbar-right" />
            </header>

            {/* ── 3-PANEL ROW ── */}
            <div className="panels-row">

                {/* LEFT PANEL */}
                <aside className="left-panel" style={{ width: leftW, minWidth: leftW, maxWidth: leftW, flexShrink: 0 }}>
                    <div className="left-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>Library</span>
                        <button
                            onClick={runIndexLibrary}
                            disabled={indexing}
                            title="Re-index all product images into SQLite catalog"
                            style={{ fontSize: '0.54rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: 4,
                                background: indexing ? 'rgba(255,255,255,0.06)' : 'rgba(201,168,76,0.15)',
                                border: '1px solid rgba(201,168,76,0.3)', color: 'var(--gold)',
                                cursor: indexing ? 'default' : 'pointer', letterSpacing: '0.04em' }}
                        >
                            {indexing ? '⏳' : '⚡ Index'}
                        </button>
                    </div>
                    {indexMsg && <div style={{ fontSize: '0.6rem', color: 'var(--accent-green)', padding: '0.25rem 0.75rem', background: 'rgba(48,209,88,0.08)', borderBottom: '1px solid rgba(48,209,88,0.15)' }}>{indexMsg}</div>}
                    <div className="folder-tree">
                        {isLoadingLibrary ? (
                            <div style={{ padding: '1rem 0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>Loading…</div>
                        ) : (
                            <>
                                <div
                                    className={`folder-row${showAllFolders ? ' active' : ''}`}
                                    onClick={() => { setShowAllFolders(true); setSelectedFolder(null); setPreviewImage(null); setActiveStrip(null); }}
                                >
                                    <span className="folder-icon">🗂</span>
                                    <span className="folder-name">All Folders</span>
                                    <span className="folder-count">{Object.values(productLibrary).reduce((a, b) => a + b.length, 0)}</span>
                                </div>
                                <div style={{ height: '1px', background: 'var(--lr-border)', margin: '0.2rem 0' }} />
                                {Object.entries(productLibrary).map(([folder, images]) => {
                                    const selCount = images.filter(i => selectedRefPaths.includes(i.path)).length;
                                    return (
                                        <div key={folder}
                                            className={`folder-row${!showAllFolders && selectedFolder === folder ? ' active' : ''}`}
                                            onClick={() => { setSelectedFolder(folder); setShowAllFolders(false); setPreviewImage(null); setActiveStrip(null); }}
                                        >
                                            <span className="folder-icon">📁</span>
                                            <span className="folder-name">{folder}</span>
                                            {selCount > 0 && <span className="sel-badge">{selCount}</span>}
                                            <span className="folder-count">{images.length}</span>
                                        </div>
                                    );
                                })}
                            </>
                        )}
                    </div>

                    {/* References drop zone */}
                    <div className="left-panel-section">References</div>
                    <div
                        style={{ padding: '0.4rem 0.5rem', minHeight: '80px', background: isDragOverRefs ? 'rgba(10,132,255,0.08)' : 'transparent', transition: 'background 0.15s' }}
                        onDragOver={e => { e.preventDefault(); setIsDragOverRefs(true); }}
                        onDragLeave={() => setIsDragOverRefs(false)}
                        onDrop={handleDropOnRefs}
                    >
                        {selectedRefPaths.length === 0 && uploadedRefs.length === 0 ? (
                            <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', padding: '0.5rem 0.25rem', textAlign: 'center' }}>
                                {isDragOverRefs ? '⬇ Drop here' : 'Drag images here or dbl-click (max 5)'}
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '3px' }}>
                                {selectedRefPaths.map((path, i) => {
                                    const role = refTags.get(path);
                                    return (
                                        <div key={path} style={{ aspectRatio: '1', borderRadius: '3px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(10,132,255,0.5)', cursor: 'pointer' }}>
                                            {isVideoFile(path) ? (
                                                <video src={path} muted playsInline preload="metadata"
                                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                    onClick={() => toggleRefSelection(path)} />
                                            ) : (
                                                <img src={thumbUrl(path, 200)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" onClick={() => toggleRefSelection(path)} />
                                            )}
                                            {/* role badge */}
                                            <button onClick={e => { e.stopPropagation(); cycleRefTag(path); }}
                                                style={{ position: 'absolute', bottom: 1, left: 1, border: 'none', borderRadius: 2, padding: '1px 3px', fontSize: '0.44rem', fontWeight: 700, cursor: 'pointer', lineHeight: 1.2, background: role ? REF_ROLE_COLORS[role] : 'rgba(0,0,0,0.55)', color: '#fff' }}>
                                                {role || '＋Tag'}
                                            </button>
                                            {/* reorder arrows */}
                                            <div style={{ position: 'absolute', top: 1, left: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                                                <button onClick={e => { e.stopPropagation(); moveRef(path, -1); }} disabled={i === 0}
                                                    style={{ border: 'none', borderRadius: 2, background: 'rgba(0,0,0,0.6)', color: i === 0 ? 'rgba(255,255,255,0.25)' : '#fff', fontSize: '0.44rem', lineHeight: 1, padding: '1px 2px', cursor: i === 0 ? 'default' : 'pointer' }}>▲</button>
                                                <button onClick={e => { e.stopPropagation(); moveRef(path, 1); }} disabled={i === selectedRefPaths.length - 1}
                                                    style={{ border: 'none', borderRadius: 2, background: 'rgba(0,0,0,0.6)', color: i === selectedRefPaths.length - 1 ? 'rgba(255,255,255,0.25)' : '#fff', fontSize: '0.44rem', lineHeight: 1, padding: '1px 2px', cursor: i === selectedRefPaths.length - 1 ? 'default' : 'pointer' }}>▼</button>
                                            </div>
                                            {/* position badge (1st = piano anchor) */}
                                            <div style={{ position: 'absolute', top: 1, right: 14, fontSize: '0.42rem', background: i === 0 ? 'var(--accent)' : 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 2, padding: '1px 3px', fontWeight: 700 }}>{i === 0 ? '①' : `${i+1}`}</div>
                                            <div onClick={() => toggleRefSelection(path)} style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.75)', width: '12px', height: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.45rem', color: '#fff' }}>✕</div>
                                        </div>
                                    );
                                })}
                                {uploadedRefs.map(ref => {
                                    const role = refTags.get(ref.id);
                                    return (
                                        <div key={ref.id} style={{ aspectRatio: '1', borderRadius: '3px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer' }}>
                                            <img src={ref.dataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onClick={() => setUploadedRefs(prev => prev.filter(r => r.id !== ref.id))} />
                                            <button onClick={e => { e.stopPropagation(); cycleRefTag(ref.id); }}
                                                style={{ position: 'absolute', bottom: 1, left: 1, border: 'none', borderRadius: 2, padding: '1px 3px', fontSize: '0.44rem', fontWeight: 700, cursor: 'pointer', lineHeight: 1.2, background: role ? REF_ROLE_COLORS[role] : 'rgba(0,0,0,0.55)', color: '#fff' }}>
                                                {role || '＋Tag'}
                                            </button>
                                            <div onClick={() => setUploadedRefs(prev => prev.filter(r => r.id !== ref.id))} style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.75)', width: '12px', height: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.45rem', color: '#fff' }}>✕</div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span style={{ fontSize: '0.62rem', color: activeRefCount > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>{activeRefCount}/5</span>
                            <button className="btn btn-ghost btn-sm" style={{ padding: '0.12rem 0.38rem', fontSize: '0.6rem', marginLeft: 'auto' }} onClick={() => fileInputRef.current?.click()}>+ Upload</button>
                            {activeRefCount > 0 && <button className="btn btn-ghost btn-sm" style={{ padding: '0.12rem 0.38rem', fontSize: '0.6rem', color: 'var(--accent-red)' }} onClick={() => { setSelectedRefPaths([]); setUploadedRefs([]); }}>Clear</button>}
                            <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display: 'none' }} onChange={e => e.target.files && handleFiles(e.target.files)} />
                        </div>
                        {/* Priority funnel */}
                        {activeRefCount > 0 && (
                            <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--lr-border)', paddingTop: '0.4rem' }}>
                                <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>Priority Order</div>
                                {priorityOrder.map((role, i) => (
                                    <div key={role} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.22rem' }}>
                                        <span style={{ fontSize: '0.52rem', color: 'var(--text-muted)', width: 12, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                                        <div style={{ flex: 1, background: REF_ROLE_COLORS[role] + '22', border: `1px solid ${REF_ROLE_COLORS[role]}55`, borderRadius: 4, padding: '0.18rem 0.4rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: REF_ROLE_COLORS[role], display: 'inline-block', flexShrink: 0 }} />
                                            <span style={{ fontSize: '0.64rem', fontWeight: 600, color: REF_ROLE_COLORS[role] }}>{role}</span>
                                            <span style={{ fontSize: '0.54rem', color: 'var(--text-muted)', marginLeft: 2 }}>
                                                {role === 'Product' ? '— layout anchor' : role === 'Talent' ? '— model/actor' : '— setting/bg'}
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                            <button onClick={() => movePriority(role, -1)} disabled={i === 0} style={{ border: 'none', background: 'none', color: i === 0 ? 'var(--lr-border)' : 'var(--text-muted)', cursor: i === 0 ? 'default' : 'pointer', fontSize: '0.55rem', lineHeight: 1, padding: 0 }}>▲</button>
                                            <button onClick={() => movePriority(role, 1)} disabled={i === priorityOrder.length - 1} style={{ border: 'none', background: 'none', color: i === priorityOrder.length - 1 ? 'var(--lr-border)' : 'var(--text-muted)', cursor: i === priorityOrder.length - 1 ? 'default' : 'pointer', fontSize: '0.55rem', lineHeight: 1, padding: 0 }}>▼</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* ── GENERATION HISTORY ── */}
                    <div className="left-panel-section" style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                        onClick={() => setShowHistory(h => !h)}>
                        <span>History</span>
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{genHistory.length > 0 ? `${genHistory.length}` : ''} {showHistory ? '▲' : '▼'}</span>
                    </div>
                    {showHistory && (
                        <div style={{ overflowY: 'auto', maxHeight: '240px' }}>
                            {genHistory.length === 0 ? (
                                <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.64rem', color: 'var(--text-muted)' }}>No history yet. Generate something!</div>
                            ) : genHistory.map(entry => (
                                <div key={entry.id} className="hist-entry"
                                    onClick={() => { if (editingHistoryId !== entry.id) restoreFromHistory(entry); }}
                                    title={editingHistoryId === entry.id ? '' : 'Click to restore prompt + refs'}>
                                    <div className="hist-meta">
                                        <span className="hist-time">{new Date(entry.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        <span className="hist-model">{entry.modelName.replace('Gemini ', '').replace(' Image', '')}</span>
                                        <button className="hist-del" onClick={e => { e.stopPropagation(); deleteHistoryEntry(entry.id); setGenHistory(prev => prev.filter(h => h.id !== entry.id)); }} title="Remove">✕</button>
                                    </div>
                                    {editingHistoryId === entry.id ? (
                                        <div onClick={e => e.stopPropagation()} style={{ marginBottom: '0.3rem' }}>
                                            <textarea
                                                className="lr-textarea"
                                                style={{ fontSize: '0.68rem', minHeight: '60px', marginBottom: '0.3rem' }}
                                                value={editingPrompt}
                                                onChange={e => setEditingPrompt(e.target.value)}
                                                autoFocus
                                            />
                                            <div style={{ display: 'flex', gap: '0.3rem' }}>
                                                <button className="btn btn-gold btn-sm" style={{ flex: 1, fontSize: '0.62rem', justifyContent: 'center' }}
                                                    onClick={() => saveHistoryEdit(entry.id, editingPrompt)}>Save</button>
                                                <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.62rem' }}
                                                    onClick={() => setEditingHistoryId(null)}>Cancel</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="hist-prompt">{(entry.enhancedPrompt || entry.prompt).slice(0, 90)}{((entry.enhancedPrompt || entry.prompt).length > 90 ? '…' : '')}</div>
                                    )}
                                    {entry.refPaths.length > 0 && (
                                        <div className="hist-refs">
                                            {entry.refPaths.slice(0, 4).map(p => (
                                                <img key={p} src={p} alt="" className="hist-ref-thumb" />
                                            ))}
                                            {entry.refPaths.length > 4 && <span className="hist-ref-more">+{entry.refPaths.length - 4}</span>}
                                        </div>
                                    )}
                                    {entry.uploadedRefNames.length > 0 && (
                                        <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                                            📎 {entry.uploadedRefNames.slice(0, 2).join(', ')}{entry.uploadedRefNames.length > 2 ? ` +${entry.uploadedRefNames.length - 2}` : ''}
                                        </div>
                                    )}
                                    <div className="hist-formats">{entry.formatLabels.slice(0, 3).join(' · ')}{entry.formatLabels.length > 3 ? ` +${entry.formatLabels.length - 3}` : ''}</div>
                                    {editingHistoryId !== entry.id && (
                                        <div className="hist-actions" onClick={e => e.stopPropagation()}>
                                            <button className="hist-action-btn" onClick={() => { setEditingHistoryId(entry.id); setEditingPrompt(entry.prompt); }}>✏ Edit</button>
                                            <button className="hist-action-btn regen" onClick={() => reGenerateFromHistory(entry)} disabled={isGenerating}>⚡ Re-generate</button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    {/* ── SAVED OUTPUTS ── */}
                    {(() => {
                        const outputDates = Object.keys(savedOutputs).sort().reverse();
                        const totalOutputs = outputDates.reduce((s, d) => s + savedOutputs[d].length, 0);
                        return (
                            <>
                                <div className="left-panel-section" style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                                    onClick={() => setShowOutputs(o => !o)}>
                                    <span>Saved Outputs</span>
                                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{totalOutputs > 0 ? totalOutputs : ''} {showOutputs ? '▲' : '▼'}</span>
                                </div>
                                {showOutputs && (
                                    <div style={{ overflowY: 'auto', maxHeight: '320px' }}>
                                        {outputDates.length === 0 ? (
                                            <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.64rem', color: 'var(--text-muted)' }}>No saved outputs yet.</div>
                                        ) : outputDates.map(date => (
                                            <div key={date}>
                                                <div style={{ padding: '0.25rem 0.75rem', fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'rgba(255,255,255,0.025)', borderBottom: '1px solid var(--lr-border)' }}>{date}</div>
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3, padding: '4px' }}>
                                                    {savedOutputs[date].map(out => (
                                                        <div key={out.path} className="output-thumb-wrap"
                                                            onClick={() => {
                                                                setSelectedOutput(out);
                                                                setLightboxSrc(out.path);
                                                                if (out.prompt) setPrompt(out.prompt);
                                                                if (out.refImagePaths?.length) setSelectedRefPaths(out.refImagePaths.slice());
                                                            }}
                                                            title={out.prompt || out.formatLabel || 'Saved output'}>
                                                            <img src={thumbUrl(out.path)} alt="" className="output-thumb" loading="lazy" />
                                                            <div className="output-thumb-label">{out.formatLabel || '—'}</div>
                                                            <button className="output-thumb-del" onClick={async e => {
                                                                e.stopPropagation();
                                                                await fetch(`/api/save-generation?path=${encodeURIComponent(out.path)}`, { method: 'DELETE' });
                                                                loadSavedOutputs();
                                                                if (selectedOutput?.path === out.path) setSelectedOutput(null);
                                                            }} title="Delete">✕</button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        );
                    })()}
                </aside>

                {/* LEFT–CENTER RESIZER */}
                <div className="panel-resizer" onMouseDown={e => startPanelDrag('left', e)} />

                {/* CENTER PANEL */}
                <main className="center-panel" style={{ flex: 1, minWidth: 0 }}>
                    {currentPreviewJob ? (
                        /* Generated result preview */
                        <>
                            <div className="center-grid-header">
                                <button className="btn btn-ghost btn-sm" onClick={() => setActiveStrip(null)}>← Back</button>
                                <strong>{currentPreviewJob.formatName}</strong>
                                {currentPreviewJob.status === 'done' && currentPreviewJob.resultUrl && (
                                    <>
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            style={{ color: '#facc15', fontWeight: 700 }}
                                            onClick={() => setMaskEditorJob(currentPreviewJob)}
                                            title="Open mask editor to fix a specific region"
                                        >🎭 Mask &amp; Fix</button>
                                        <a href={currentPreviewJob.resultUrl} download className="btn btn-ghost btn-sm">↓ Download</a>
                                    </>
                                )}
                            </div>
                            <div className="center-preview">
                                {currentPreviewJob.status === 'done' && currentPreviewJob.resultUrl ? (
                                    <img src={currentPreviewJob.resultUrl} alt={currentPreviewJob.formatName} />
                                ) : currentPreviewJob.status === 'processing' ? (
                                    <div className="center-empty"><div className="spinner" style={{ width: '28px', height: '28px', borderWidth: '3px' }} /><div>Generating…</div></div>
                                ) : currentPreviewJob.status === 'error' ? (
                                    <div className="center-empty"><div className="center-empty-icon">⚠️</div><div>{currentPreviewJob.error}</div></div>
                                ) : (
                                    <div className="center-empty"><div>Queued…</div></div>
                                )}
                            </div>
                        </>
                    ) : (
                        /* Image grid */
                        <>
                            {/* Filter + controls toolbar */}
                            <div className="center-toolbar">
                                {/* Filter bar */}
                                <div className="filter-bar">
                                    <div className="filter-stars">
                                        {[1, 2, 3, 4, 5].map(n => (
                                            <span key={n} className={`filter-star${filterStars >= n ? ' active' : ''}`}
                                                onClick={() => setFilterStars(filterStars === n ? 0 : n as StarRating)}>★</span>
                                        ))}
                                        {filterStars > 0 && <button className="filter-star-reset" onClick={() => setFilterStars(0)}>✕</button>}
                                    </div>
                                    <div className="filter-sep" />
                                    {(['all', 'pick', 'unflagged', 'reject'] as const).map(f => (
                                        <button key={f} className={`filter-flag ${f}${filterFlag === f ? ' active' : ''}`}
                                            onClick={() => setFilterFlag(f)}>
                                            {f === 'all' ? 'All' : f === 'pick' ? '⚑ Pick' : f === 'unflagged' ? '⚐' : '✕ Reject'}
                                        </button>
                                    ))}
                                    <div className="filter-sep" />
                                    {LABELS.map(lbl => (
                                        <div key={lbl} className={`filter-label-dot${filterLabel === lbl ? ' active' : ''}`}
                                            style={{ background: LABEL_COLORS[lbl], border: lbl === 'none' ? '1px solid rgba(255,255,255,0.2)' : 'none' }}
                                            title={lbl} onClick={() => setFilterLabel(filterLabel === lbl ? 'all' : lbl)} />
                                    ))}
                                </div>

                                {/* Right side: view controls + slider */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
                                    <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>
                                        {visibleImages.length} {showAllFolders ? 'total' : ''}
                                    </span>
                                    <div className="thumb-slider-wrap">
                                        <span className="thumb-slider-icon">▪</span>
                                        <input type="range" className="thumb-slider" min={50} max={200} value={thumbSizeDisplay}
                                            onChange={e => {
                                                const v = Number(e.target.value);
                                                setThumbSizeDisplay(v);
                                                if (sliderTimer.current) clearTimeout(sliderTimer.current);
                                                sliderTimer.current = setTimeout(() => setThumbSize(v), 50);
                                            }} />
                                        <span className="thumb-slider-icon" style={{ fontSize: '0.82rem' }}>▪</span>
                                    </div>
                                </div>
                            </div>

                            {/* Image grid */}
                            {visibleImages.length === 0 ? (
                                <div className="center-empty" style={{ flex: 1 }}>
                                    <div className="center-empty-icon">🖼</div>
                                    <div className="center-empty-text">{isLoadingLibrary ? 'Loading…' : 'Select a folder or adjust filters'}</div>
                                </div>
                            ) : (
                                <>
                                    <div className="image-grid"
                                        style={{ columns: `${thumbSize}px`, columnGap: '0.35rem' }}>
                                        {showAllFolders && (() => {
                                            // Continuous packed grid — no separator rows
                                            const seen = new Set<string>();
                                            const rows: React.ReactNode[] = [];
                                            let _idx = 0;
                                            visibleImages.forEach(img => {
                                                const idx = _idx++;
                                                const isFirstInFolder = !seen.has(img.folder);
                                                if (isFirstInFolder) seen.add(img.folder);
                                                const m = getMeta(img.path);
                                                const isRef = selectedRefPaths.includes(img.path);
                                                const isSelected = selectedGridImage === img.path;
                                                rows.push(
                                                    <div key={img.path}
                                                        className={`image-grid-thumb${isRef ? ' selected' : ''}${m.flag === 'reject' ? ' rejected' : ''}${m.stars > 0 || m.flag !== 'unflagged' || m.label !== 'none' ? ' has-meta' : ''}`}
                                                        style={{ outline: isSelected ? '2px solid var(--accent)' : 'none', outlineOffset: '-2px' }}
                                                        draggable onDragStart={e => handleDragStart(e, img.path)}
                                                        onClick={e => handleThumbClick(e, img.path, idx)}
                                                        onDoubleClick={() => setLightboxSrc(img.path)}
                                                        title={img.name}>
                                                        {isVideoFile(img.path) ? (
                                                            <>
                                                                <video src={img.path} muted preload="metadata" playsInline
                                                                    onLoadedMetadata={e => { const v = e.target as HTMLVideoElement; v.currentTime = 0.5; handleVideoMeta(img.path, e); }} />
                                                                <div className="thumb-play-icon">▶</div>
                                                                {videoDurations[img.path] && <div className="thumb-duration">{videoDurations[img.path]}</div>}
                                                            </>
                                                        ) : (
                                                            <img src={thumbUrl(img.path)} alt={img.name} loading="lazy" />
                                                        )}
                                                        {/* Folder badge — only on first image of each folder in All view */}
                                                        {isFirstInFolder && <div className="thumb-folder-badge">{img.folder}</div>}
                                                        <div className="thumb-check">✓</div>
                                                        {m.flag === 'pick' && <div className="thumb-flag">⚑</div>}
                                                        {m.label !== 'none' && <div className="thumb-label-dot" style={{ background: LABEL_COLORS[m.label] }} />}
                                                        <div className="thumb-stars">
                                                            {[1, 2, 3, 4, 5].map(n => (
                                                                <span key={n} className={`thumb-star${m.stars >= n ? ' filled' : ''}`}
                                                                    onClick={ev => { ev.stopPropagation(); setMeta(img.path, { stars: m.stars === n ? 0 : n as StarRating }); }}>★</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            });
                                            return rows;
                                        })()}
                                        {!showAllFolders && visibleImages.map(img => {
                                            const m = getMeta(img.path);
                                            const isRef = selectedRefPaths.includes(img.path);
                                            const isSelected = selectedGridImage === img.path;
                                            return (
                                                <div key={img.path}
                                                    className={`image-grid-thumb${isRef ? ' selected' : ''}${m.flag === 'reject' ? ' rejected' : ''}${m.stars > 0 || m.flag !== 'unflagged' || m.label !== 'none' ? ' has-meta' : ''}`}
                                                    style={{ outline: isSelected ? '2px solid var(--accent)' : 'none', outlineOffset: '-2px' }}
                                                    draggable onDragStart={e => handleDragStart(e, img.path)}
                                                    onClick={e => handleThumbClick(e, img.path, allVisibleImages.findIndex(i => i.path === img.path))}
                                                    onDoubleClick={() => setLightboxSrc(img.path)}
                                                    title={img.name}>
                                                    {isVideoFile(img.path) ? (
                                                        <>
                                                            <video src={img.path} muted preload="metadata" playsInline
                                                                onLoadedMetadata={e => { const v = e.target as HTMLVideoElement; v.currentTime = 0.5; handleVideoMeta(img.path, e); }} />
                                                            <div className="thumb-play-icon">▶</div>
                                                            {videoDurations[img.path] && <div className="thumb-duration">{videoDurations[img.path]}</div>}
                                                        </>
                                                    ) : (
                                                        <img src={thumbUrl(img.path)} alt={img.name} loading="lazy" />
                                                    )}
                                                    <div className="thumb-check">✓</div>
                                                    {m.flag === 'pick' && <div className="thumb-flag">⚑</div>}
                                                    {m.label !== 'none' && <div className="thumb-label-dot" style={{ background: LABEL_COLORS[m.label] }} />}
                                                    <div className="thumb-stars">
                                                        {[1, 2, 3, 4, 5].map(n => (
                                                            <span key={n} className={`thumb-star${m.stars >= n ? ' filled' : ''}`}
                                                                onClick={ev => { ev.stopPropagation(); setMeta(img.path, { stars: m.stars === n ? 0 : n as StarRating }); }}>★</span>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {/* Load-more sentinel */}
                                    {hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
                                </>
                            )}

                            {/* Cull toolbar — shows when image is selected in grid */}
                            {selectedImageMeta && selectedGridImage && (
                                <div className="cull-toolbar">
                                    {/* Stars */}
                                    <div className="cull-stars">
                                        {[1, 2, 3, 4, 5].map(n => (
                                            <span key={n} className={`cull-star${selectedImageMeta.stars >= n ? ' filled' : ''}`}
                                                onClick={() => setMeta(selectedGridImage, { stars: selectedImageMeta.stars === n ? 0 : n as StarRating })}>★</span>
                                        ))}
                                    </div>
                                    <div className="cull-sep" />
                                    {/* Flags */}
                                    <button className={`cull-flag-btn pick${selectedImageMeta.flag === 'pick' ? ' active' : ''}`}
                                        onClick={() => setMeta(selectedGridImage, { flag: selectedImageMeta.flag === 'pick' ? 'unflagged' : 'pick' })}>
                                        ⚑ Pick
                                    </button>
                                    <button className={`cull-flag-btn reject${selectedImageMeta.flag === 'reject' ? ' active' : ''}`}
                                        onClick={() => setMeta(selectedGridImage, { flag: selectedImageMeta.flag === 'reject' ? 'unflagged' : 'reject' })}>
                                        ✕ Reject
                                    </button>
                                    <div className="cull-sep" />
                                    {/* Labels */}
                                    <div className="cull-labels">
                                        {LABELS.map(lbl => (
                                            <div key={lbl} className={`cull-label-btn${selectedImageMeta.label === lbl ? ' active' : ''}`}
                                                style={{ background: LABEL_COLORS[lbl] }}
                                                title={lbl}
                                                onClick={() => setMeta(selectedGridImage, { label: selectedImageMeta.label === lbl ? 'none' : lbl })} />
                                        ))}
                                    </div>
                                    <div className="cull-sep" />
                                    {/* Comment */}
                                    <div className="cull-comment">
                                        <input className="cull-comment-input" type="text" placeholder="Add comment…"
                                            value={selectedImageMeta.comment}
                                            onChange={e => setMeta(selectedGridImage, { comment: e.target.value })} />
                                    </div>
                                    {/* Keyboard hint */}
                                    <div className="cull-info">1-5 stars · Z pick · X reject · U unflag · ↩ add ref · ⌘click ref · ⇧click range · ⌘⌫ delete</div>
                                    <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.6rem', flexShrink: 0 }}
                                        onClick={() => { toggleRefSelection(selectedGridImage); }}>
                                        {selectedRefPaths.includes(selectedGridImage) ? '− Ref' : '+ Ref'}
                                    </button>
                                    <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.6rem', flexShrink: 0, color: 'var(--accent-red)' }}
                                        onClick={() => deleteFromLibrary(selectedGridImage)} title="Delete from library (⌘⌫)">
                                        🗑
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </main>

                {/* CENTER–RIGHT RESIZER */}
                <div className="panel-resizer" onMouseDown={e => startPanelDrag('right', e)} />

                {/* RIGHT PANEL */}
                <aside className="right-panel" style={{ width: rightW, minWidth: rightW, maxWidth: rightW, flexShrink: 0 }}>
                    <div className="right-panel-scroll">

                        {/* Model */}
                        <div className="lr-section">
                            <button className="lr-section-toggle" onClick={() => toggleRightSection('model')}>
                                <span className="lr-section-label">AI Model</span>
                                <span className={`lr-chevron${rightSections.has('model') ? ' open' : ''}`}>▲</span>
                            </button>
                            {rightSections.has('model') && (
                                <div className="lr-section-body">
                                    <div className="model-list">
                                        {MODEL_OPTIONS.map(m => (
                                            <div key={m.id} className={`model-row${selectedModel === m.id ? ' selected' : ''}`} onClick={() => setSelectedModel(m.id)}>
                                                <div className="model-dot" />
                                                <div className="model-row-name">{m.name}</div>
                                                <div className="model-row-badges">
                                                    {m.tier === 'free' && <span className="mbadge free">Free</span>}
                                                    {m.tier === 'paid' && <span className="mbadge paid">Paid</span>}
                                                    {m.type === 'video' && <span className="mbadge video">Video</span>}
                                                    {m.type === 'image' && <span className="mbadge img">Img</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Output Formats */}
                        <div className="lr-section">
                            <button className="lr-section-toggle" onClick={() => toggleRightSection('formats')}>
                                <span className="lr-section-label">Formats {selectedFormats.size > 0 ? `(${selectedFormats.size})` : ''}</span>
                                <span className={`lr-chevron${rightSections.has('formats') ? ' open' : ''}`}>▲</span>
                            </button>
                            {rightSections.has('formats') && (
                                <div className="lr-section-body">
                                    {CATEGORIES.map(cat => {
                                        const fmts = OUTPUT_FORMATS.filter(f => f.category === cat);
                                        return (
                                            <div key={cat}>
                                                <div className="fmt-section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                    <span>{CATEGORY_LABELS[cat]}</span>
                                                    <button className="select-all-btn" onClick={() => toggleAllInCategory(cat)}>
                                                        {fmts.every(f => selectedFormats.has(f.id)) ? 'None' : 'All'}
                                                    </button>
                                                </div>
                                                {fmts.map(fmt => (
                                                    <div key={fmt.id} className={`fmt-item${selectedFormats.has(fmt.id) ? ' checked' : ''}`} onClick={() => toggleFormat(fmt.id)}>
                                                        <div className="fmt-check"><span className="fmt-check-mark">✓</span></div>
                                                        <span className="fmt-name">{fmt.label}</span>
                                                        <span className="fmt-dims">{fmt.width}×{fmt.height}</span>
                                                        <span className={`fmt-type ${fmt.type}`}>{fmt.type}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Product Specs */}
                        <div className="lr-section">
                            <button className="lr-section-toggle" onClick={() => toggleRightSection('specs')}>
                                <span className="lr-section-label">
                                    Product Specs
                                    {Object.values(productSpecs).some(Boolean) && (
                                        <span style={{ marginLeft: '0.35rem', fontSize: '0.58rem', color: 'var(--accent)', fontWeight: 700 }}>
                                            ● {Object.values(productSpecs).filter(Boolean).length}
                                        </span>
                                    )}
                                </span>
                                <span className={`lr-chevron${rightSections.has('specs') ? ' open' : ''}`}>▲</span>
                            </button>
                            {rightSections.has('specs') && (
                                <div className="lr-section-body" style={{ paddingBottom: '0.25rem' }}>
                                    {Object.values(productSpecs).some(Boolean) && (
                                        <button className="brand-tag" style={{ opacity: 0.5, marginBottom: '0.4rem' }}
                                            onClick={() => setProductSpecs({})}>✕ Clear all specs</button>
                                    )}
                                    {PRODUCT_SPECS.map(spec => (
                                        <div key={spec.key} style={{ marginBottom: '0.35rem' }}>
                                            <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.2rem' }}>
                                                {spec.group}
                                            </div>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                                {spec.options.map(opt => (
                                                    <button
                                                        key={opt}
                                                        className={`brand-tag${productSpecs[spec.key] === opt ? ' active' : ''}`}
                                                        onClick={() => setSpec(spec.key, opt)}
                                                    >{opt}</button>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Prompt */}
                        <div className="lr-section">
                            <button className="lr-section-toggle" onClick={() => toggleRightSection('prompt')}>
                                <span className="lr-section-label">Prompt</span>
                                <span className={`lr-chevron${rightSections.has('prompt') ? ' open' : ''}`}>▲</span>
                            </button>
                            {rightSections.has('prompt') && (
                                <div className="lr-section-body">
                                    {/* Brand Style master toggle */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                                        <div style={{ fontSize: '0.6rem', color: useBrandStyle ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                            {useBrandStyle && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', boxShadow: '0 0 5px var(--accent)' }} />}
                                            Brand Style
                                        </div>
                                        <button
                                            onClick={() => setUseBrandStyle(v => !v)}
                                            style={{
                                                background: useBrandStyle ? 'var(--accent)' : 'rgba(255,255,255,0.08)',
                                                border: 'none', borderRadius: '100px',
                                                width: 32, height: 18, position: 'relative', cursor: 'pointer',
                                                transition: 'background 0.2s', flexShrink: 0,
                                            }}
                                            title={useBrandStyle ? 'Brand style ON — click to disable' : 'Brand style OFF — click to enable'}
                                        >
                                            <span style={{
                                                position: 'absolute', top: 2,
                                                left: useBrandStyle ? 16 : 2,
                                                width: 14, height: 14, borderRadius: '50%',
                                                background: '#fff', transition: 'left 0.2s',
                                                boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                                            }} />
                                        </button>
                                    </div>
                                    {useBrandStyle && (
                                    <div className="brand-tags" style={{ marginBottom: '0.6rem' }}>
                                        {brandTags.slice(0, 12).map(tag => (
                                            <button key={tag} className={`brand-tag${activeBrandTags.has(tag) ? ' active' : ''}`} onClick={() => toggleBrandTag(tag)}>{tag}</button>
                                        ))}
                                        {BRAND_STYLE_PRESETS.map(preset => (
                                            <button key={preset.label} className="brand-tag"
                                                onClick={() => { setBrandTags(prev => [...new Set([...prev, ...preset.words])]); setActiveBrandTags(prev => new Set([...prev, ...preset.words])); }}>
                                                + {preset.label}
                                            </button>
                                        ))}
                                    </div>
                                    )}
                                    {/* ── Prompt Presets ── */}
                                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', alignSelf: 'center', marginRight: '0.15rem' }}>Presets:</span>
                                        <button
                                            className={`brand-tag${useStarterPreset ? ' active' : ''}`}
                                            title="Toggle DS 6.0 generation starter — auto-prepended to every generation"
                                            onClick={() => setUseStarterPreset(v => !v)}>
                                            ⚡ DS 6.0 Starter
                                        </button>
                                        <button
                                            className={`brand-tag${useNegativeGuard ? ' active' : ''}`}
                                            title="Toggle negative constraints — stops hallucinations of all DS 6.0 elements"
                                            onClick={() => setUseNegativeGuard(v => !v)}>
                                            🚫 Negative Guard
                                        </button>
                                        <button className="brand-tag" style={{ opacity: 0.5 }} title="Clear prompt"
                                            onClick={() => setPrompt('')}>✕ Clear</button>
                                    </div>
                                    <textarea className="lr-textarea" value={prompt} onChange={e => setPrompt(e.target.value)}
                                        placeholder="Describe the image you want to generate…" rows={4} />
                                    <button className="btn btn-ghost btn-sm" style={{ marginTop: '0.4rem', width: '100%', justifyContent: 'center' }}
                                        onClick={enhancePromptHandler} disabled={isEnhancing || !prompt.trim()}>
                                        {isEnhancing ? <><span className="spinner" /> Enhancing…</> : '✨ AI Enhance'}
                                    </button>
                                    {enhancedPrompt && (
                                        <div className="enhanced-box" style={{ marginTop: '0.5rem' }}>
                                            <div className="enhanced-label">Enhanced</div>
                                            {enhancedPrompt}
                                        </div>
                                    )}
                                    {/* Live Effective Prompt Preview */}
                                    {(useStarterPreset || useNegativeGuard || Object.values(productSpecs).some(Boolean)) && (() => {
                                        const base = enhancedPrompt || prompt || '(your prompt here)';
                                        const presetParts = [
                                            useStarterPreset ? PRESET_DS60_STARTER : '',
                                            useNegativeGuard ? PRESET_NEGATIVE_GUARD : '',
                                        ].filter(Boolean);
                                        const specLines = PRODUCT_SPECS.filter(s => productSpecs[s.key]).map(s => `${s.group}: ${productSpecs[s.key]}`);
                                        const specBlock = specLines.length ? `\n\nPRODUCT SPECS (follow strictly):\n${specLines.join('\n')}` : '';
                                        const fullPrompt = (presetParts.length ? presetParts.join('\n\n') + '\n\n' : '') + base + specBlock;
                                        return (
                                            <div style={{
                                                marginTop: '0.5rem',
                                                background: 'rgba(255,255,255,0.03)',
                                                border: '1px solid rgba(255,255,255,0.08)',
                                                borderRadius: '4px',
                                                padding: '0.5rem 0.6rem',
                                                fontSize: '0.6rem',
                                                lineHeight: 1.6,
                                                color: 'var(--text-muted)',
                                                maxHeight: '140px',
                                                overflowY: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                            }}>
                                                <div style={{ fontSize: '0.55rem', color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.3rem' }}>⚡ Effective Prompt Preview</div>
                                                {fullPrompt}
                                            </div>
                                        );
                                    })()}
                                    {activeRefCount > 0 && <div className="hint" style={{ marginTop: '0.4rem' }}>✓ {activeRefCount} reference{activeRefCount > 1 ? 's' : ''} will be used</div>}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Generate footer */}
                    <div className="right-panel-footer">
                        <div className="gen-summary">
                            <div><span className="gen-count">{selectedFormats.size}</span><span style={{ marginLeft: '0.3rem' }}>format{selectedFormats.size !== 1 ? 's' : ''}</span></div>
                            {activeRefCount > 0 && <span style={{ color: 'var(--accent)', fontSize: '0.7rem' }}>{activeRefCount} ref{activeRefCount > 1 ? 's' : ''}</span>}
                        </div>
                        <button className="btn btn-gold" disabled={isGenerating || !selectedFormats.size || !prompt.trim()} onClick={startGeneration}>
                            {isGenerating
                                ? <><span className="spinner" /> Generating…</>
                                : <>⚡ Generate {selectedFormats.size > 0 && <span style={{ opacity: 0.75, fontSize: '0.8em', marginLeft: 4 }}>({selectedFormats.size} {selectedFormats.size === 1 ? 'Asset' : 'Assets'})</span>}</>}
                        </button>

                    </div>
                </aside>
            </div>

            {/* ── FILMSTRIP ── */}
            <footer className="filmstrip">
                {jobs.length === 0 ? (
                    <div className="strip-empty">Checked formats generate as separate assets — all from the same prompt. Select formats above then click Generate.</div>
                ) : (() => {
                    // Group jobs by batchId, preserve insertion order
                    const batches: { batchId: string; jobs: GenerationJob[] }[] = [];
                    const seen = new Map<string, GenerationJob[]>();
                    for (const job of jobs) {
                        if (!seen.has(job.batchId)) { seen.set(job.batchId, []); batches.push({ batchId: job.batchId, jobs: seen.get(job.batchId)! }); }
                        seen.get(job.batchId)!.push(job);
                    }
                    return batches.map(batch => (
                        <div key={batch.batchId} className="strip-batch">
                            <div className="strip-batch-label">
                                <span className="strip-batch-count">{batch.jobs.length} {batch.jobs.length === 1 ? 'asset' : 'assets'}</span>
                                <span className="strip-batch-prompt">{(batch.jobs[0]?.prompt || '').slice(0, 40)}{(batch.jobs[0]?.prompt || '').length > 40 ? '…' : ''}</span>
                                {batch.jobs.some(j => j.status === 'processing' || j.status === 'queued') && (
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        style={{ marginLeft: 'auto', fontSize: '0.6rem', opacity: 0.7, padding: '1px 6px' }}
                                        title="Cancel remaining generations in this batch"
                                        onClick={() => setJobs(prev => prev.map(j =>
                                            j.batchId === batch.batchId && (j.status === 'processing' || j.status === 'queued')
                                                ? { ...j, status: 'error', error: 'Cancelled' }
                                                : j
                                        ))}
                                    >✕ Cancel</button>
                                )}
                            </div>
                            <div className="strip-batch-items">
                                {batch.jobs.map(job => (
                                    <div key={job.id} className={`strip-item${activeStrip === job.id ? ' active' : ''}`}
                                        onClick={() => { setActiveStrip(job.id); setPreviewImage(null); }}>
                                        {job.status === 'done' && job.resultUrl ? (
                                            <img src={job.resultUrl} alt={job.formatName} loading="lazy" />
                                        ) : (
                                            <div className={`strip-status ${job.status}`}>
                                                {job.status === 'processing' && <span className="spinner" />}
                                                {job.status === 'queued' && <span>⏳</span>}
                                                {job.status === 'error' && <span>⚠</span>}
                                                <span>{job.status}</span>
                                            </div>
                                        )}
                                        {job.status === 'done' && (
                                            <div className="strip-feedback">
                                                <button className={`strip-fb-btn good${job.feedback === 'good' ? ' active' : ''}`}
                                                    onClick={e => openPositiveFeedback(job, e)}
                                                    title="Loved it — generate more like this">👍</button>
                                                <button className={`strip-fb-btn bad${job.feedback === 'bad' ? ' active' : ''}`}
                                                    onClick={e => openFeedback(job, e)}
                                                    title="Flag issues">👎</button>
                                            </div>
                                        )}
                                        <div className="strip-label">{job.formatLabel}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ));
                })()}
            </footer>
            {/* ── FEEDBACK MODAL ── */}
            {fbJob && (
                <div className="fb-overlay" onClick={closeFeedback}>
                    <div className="fb-modal" onClick={e => e.stopPropagation()}>
                        <div className="fb-modal-title">👎 Flag Generation Issue</div>
                        <div className="fb-modal-sub">
                            {fbJob.formatLabel} · {fbJob.modelName}<br />
                            Prompt: <em>{(fbJob.prompt || '').slice(0, 80)}{(fbJob.prompt || '').length > 80 ? '…' : ''}</em>
                        </div>
                        <div className="fb-chips">
                            {FEEDBACK_ISSUES.map(issue => (
                                <button key={issue}
                                    className={`fb-chip${fbIssues.includes(issue) ? ' selected' : ''}`}
                                    onClick={() => toggleIssue(issue)}>
                                    {issue}
                                </button>
                            ))}
                        </div>
                        <textarea className="fb-note" placeholder="Additional notes (optional)…"
                            value={fbNote} onChange={e => setFbNote(e.target.value)} />
                        <div className="fb-actions">
                            <button className="btn btn-ghost btn-sm" onClick={closeFeedback} disabled={fbSubmitting}>Cancel</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => submitFeedback(false)} disabled={fbSubmitting}>
                                {fbSubmitting ? 'Saving…' : '💾 Save Feedback'}
                            </button>
                            <button className="btn btn-gold btn-sm" onClick={() => submitFeedback(true)} disabled={fbSubmitting}>
                                {fbSubmitting ? 'Generating…' : '⚡ Fix & Re-generate'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* ── POSITIVE FEEDBACK MODAL ── */}
            {posJob && (
                <div className="fb-overlay" onClick={closePosModal}>
                    <div className="fb-modal" onClick={e => e.stopPropagation()}>
                        <div className="fb-modal-title" style={{ color: '#4ade80' }}>🌟 What made this great?</div>
                        <div className="fb-modal-sub">
                            {posJob.formatLabel} · {posJob.modelName}<br />
                            Prompt: <em>{(posJob.prompt || '').slice(0, 80)}{(posJob.prompt || '').length > 80 ? '…' : ''}</em>
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>Select everything you loved — the next generation will amplify these qualities:</div>
                        <div className="fb-chips">
                            {POSITIVE_QUALITIES.map(q => (
                                <button key={q}
                                    className={`fb-chip${posQualities.includes(q) ? ' selected' : ''}`}
                                    onClick={() => toggleQuality(q)}>
                                    {q}
                                </button>
                            ))}
                        </div>
                        <textarea className="fb-note" placeholder="Anything else you want to amplify or keep? (optional)"
                            value={posNote} onChange={e => setPosNote(e.target.value)} />
                        <div className="fb-actions">
                            <button className="btn btn-ghost btn-sm" onClick={closePosModal} disabled={posSubmitting}>Cancel</button>
                            <button className="btn btn-gold btn-sm" onClick={submitPositiveFeedback} disabled={posSubmitting}>
                                {posSubmitting ? <><span className="spinner" /> Generating…</> : '⚡ Generate More Like This'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        {/* ─── LIGHTBOX OVERLAY ─────────────────────────────────────── */}
        {lightboxSrc && (
            <div
                style={{
                    position: 'fixed', inset: 0, zIndex: 9999,
                    background: 'rgba(0,0,0,0.92)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    backdropFilter: 'blur(6px)',
                }}
                onClick={() => setLightboxSrc(null)}
            >
                {/* Toolbar */}
                <div
                    style={{
                        position: 'absolute', top: 0, left: 0, right: 0,
                        display: 'flex', alignItems: 'center', gap: '0.75rem',
                        padding: '0.6rem 1rem',
                        background: 'rgba(0,0,0,0.6)',
                        backdropFilter: 'blur(8px)',
                        borderBottom: '1px solid rgba(255,255,255,0.08)',
                    }}
                    onClick={e => e.stopPropagation()}
                >
                    <button className="btn btn-ghost btn-sm" onClick={() => setLightboxSrc(null)}>✕ Close</button>
                    <span style={{ fontSize: '0.7rem', opacity: 0.6, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lightboxSrc.split('/').pop()}
                    </span>
                    <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: selectedRefPaths.includes(lightboxSrc) ? 'var(--accent)' : undefined }}
                        onClick={() => toggleRefSelection(lightboxSrc)}
                        disabled={!selectedRefPaths.includes(lightboxSrc) && selectedRefPaths.length >= 5}
                    >
                        {selectedRefPaths.includes(lightboxSrc) ? '★ In References' : '☆ Add to Refs'}
                    </button>
                    <a href={lightboxSrc} download className="btn btn-ghost btn-sm">↓ Download</a>
                </div>
                {/* Image / Video */}
                {isVideoFile(lightboxSrc) ? (
                    <video
                        src={lightboxSrc}
                        controls
                        autoPlay
                        style={{
                            maxWidth: 'calc(100vw - 48px)',
                            maxHeight: 'calc(100vh - 100px)',
                            borderRadius: '4px',
                            boxShadow: '0 8px 64px rgba(0,0,0,0.8)',
                            marginTop: '52px',
                        }}
                        onClick={e => e.stopPropagation()}
                    />
                ) : (
                    <img
                        src={lightboxSrc}
                        alt="Preview"
                        style={{
                            maxWidth: 'calc(100vw - 48px)',
                            maxHeight: 'calc(100vh - 100px)',
                            objectFit: 'contain',
                            borderRadius: '4px',
                            boxShadow: '0 8px 64px rgba(0,0,0,0.8)',
                            marginTop: '52px',
                        }}
                        onClick={e => e.stopPropagation()}
                    />
                )}
                <div style={{ fontSize: '0.62rem', opacity: 0.35, marginTop: '0.4rem' }}>Esc or click outside to close</div>
            </div>
        )}
        {/* ── MASK EDITOR MODAL ── */}
        {maskEditorJob && maskEditorJob.resultUrl && (() => {
            // Extract raw base64 from the data URL
            const [header, b64] = maskEditorJob.resultUrl.split(',');
            const mimeType = header.replace('data:', '').replace(';base64', '');
            return (
                <MaskEditor
                    imageBase64={b64}
                    imageMimeType={mimeType}
                    modelId={maskEditorJob.modelId}
                    formatLabel={maskEditorJob.formatLabel}
                    onResult={(base64, mime) => {
                        const resultUrl = `data:${mime};base64,${base64}`;
                        const newJob: GenerationJob = {
                            id: `inpaint-${Date.now()}-${Math.random()}`,
                            batchId: maskEditorJob.batchId,
                            status: 'done',
                            formatId: maskEditorJob.formatId,
                            formatLabel: maskEditorJob.formatLabel + ' (fixed)',
                            formatName: (maskEditorJob.formatName ?? maskEditorJob.formatLabel) + ' (fixed)',
                            modelId: maskEditorJob.modelId,
                            modelName: maskEditorJob.modelName,
                            prompt: maskEditorJob.prompt,
                            resultUrl,
                            createdAt: Date.now(),
                            completedAt: Date.now(),
                        };
                        setJobs(prev => [newJob, ...prev]);
                        setActiveStrip(newJob.id);
                        setMaskEditorJob(null);
                    }}
                    onClose={() => setMaskEditorJob(null)}
                />
            );
        })()}
        </div>
    );
}
