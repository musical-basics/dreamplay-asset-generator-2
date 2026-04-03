'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { OUTPUT_FORMATS, MODEL_OPTIONS, CATEGORY_LABELS } from '@/lib/output-formats';
import { DEFAULT_BRAND_CONFIG, BRAND_STYLE_PRESETS } from '@/lib/brand-config';
import type { OutputFormat, ModelOption, GenerationJob, ReferenceFile, HistoryEntry, SavedOutput } from '@/types';

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

// ─── Library asset type (from Media Indexer catalog) ────────────────────────
interface LibraryAsset {
    id: string; filePath: string; fileName: string; fileSize: number;
    mediaType: 'video' | 'image'; durationSeconds: number | null;
    subject: string; handZone: string | null; dsModel: string | null;
    purpose: string; campaign: string; shotType: string; finalStatus: string;
    colorLabel: string | null; priority: string; mood: string; colorGrade: string;
    aiDescription: string; aiKeywords: string; thumbPath: string | null;
    orientation: string | null; width: number | null; height: number | null;
    codec: string | null; fps: number | null;
}
interface LibStats { total: number; finals: number; highPriority: number; }

export default function HomePage() {
    // ─── Core state ───────────────────────────────────────────────────────────────

    const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
    const [selectedModel, setSelectedModel] = useState<string>('gemini-flash-image');
    const [prompt, setPrompt] = useState('');
    const [enhancedPrompt, setEnhancedPrompt] = useState('');
    const [isEnhancing, setIsEnhancing] = useState(false);
    const [brandTags, setBrandTags] = useState<string[]>(DEFAULT_BRAND_CONFIG.styleWords);
    const [activeBrandTags, setActiveBrandTags] = useState<Set<string>>(new Set(DEFAULT_BRAND_CONFIG.styleWords));
    const [useBrandStyle, setUseBrandStyle] = useState<boolean>(true);
    // ─── Restore persisted state after mount (avoids SSR hydration mismatch) ─────
    useEffect(() => {
        setSelectedModel(localStorage.getItem('dp_model') || 'gemini-flash-image');
        setPrompt(localStorage.getItem('dp_prompt') || '');
        setEnhancedPrompt(localStorage.getItem('dp_enhanced_prompt') || '');
        setUseBrandStyle(localStorage.getItem('dp_brand_style') !== 'off');
        try {
            const storedJobs = JSON.parse(sessionStorage.getItem('dp_jobs') || '[]');
            if (storedJobs.length) setJobs(storedJobs);
        } catch { }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => { localStorage.setItem('dp_brand_style', useBrandStyle ? 'on' : 'off'); }, [useBrandStyle]);

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

    const [rightSections, setRightSections] = useState<Set<string>>(new Set(['model', 'formats', 'prompt']));

    // ─── Tab: Generator vs Library ────────────────────────────────────────────────
    const [activeTab, setActiveTab] = useState<'generator' | 'library'>('generator');
    const [libAssets, setLibAssets] = useState<LibraryAsset[]>([]);
    const [libTotal, setLibTotal] = useState(0);
    const [libStats, setLibStats] = useState<LibStats>({ total: 0, finals: 0, highPriority: 0 });
    const [libSelected, setLibSelected] = useState<Set<string>>(new Set());
    const [libLoading, setLibLoading] = useState(false);
    const [libNotIndexed, setLibNotIndexed] = useState(false);
    const [libDetail, setLibDetail] = useState<LibraryAsset | null>(null);
    const [libCopyMsg, setLibCopyMsg] = useState('');
    const [libExporting, setLibExporting] = useState(false);
    const [libFilters, setLibFilters] = useState({
        search: '', finalStatus: '', priority: '', subject: '',
        handZone: '', dsModel: '', purpose: '', campaign: '',
        shotType: '', colorLabel: '', mediaType: '', orientation: '',
    });
    const libLastClick = useRef<string | null>(null);

    const fetchLibrary = useCallback(async () => {
        setLibLoading(true);
        const params = new URLSearchParams();
        Object.entries(libFilters).forEach(([k, v]) => { if (v) params.set(k, v); });
        try {
            const res = await fetch(`/api/media-library?${params}`);
            const data = await res.json();
            if (data.notIndexed) { setLibNotIndexed(true); setLibAssets([]); }
            else { setLibNotIndexed(false); setLibAssets(data.assets ?? []); setLibTotal(data.total ?? 0); setLibStats(data.stats ?? { total: 0, finals: 0, highPriority: 0 }); }
        } catch { }
        setLibLoading(false);
    }, [libFilters]);

    useEffect(() => { if (activeTab === 'library') fetchLibrary(); }, [activeTab, fetchLibrary]);

    function setLibFilter(key: string, value: string) {
        setLibFilters(prev => ({ ...prev, [key]: (prev as Record<string, string>)[key] === value ? '' : value }));
    }

    function handleLibClick(asset: LibraryAsset, e: React.MouseEvent) {
        if (e.shiftKey && libLastClick.current) {
            const ids = libAssets.map(a => a.id);
            const li = ids.indexOf(libLastClick.current); const ci = ids.indexOf(asset.id);
            const [s, en] = li < ci ? [li, ci] : [ci, li];
            setLibSelected(prev => { const n = new Set(prev); ids.slice(s, en + 1).forEach(id => n.add(id)); return n; });
        } else if (e.metaKey || e.ctrlKey) {
            setLibSelected(prev => { const n = new Set(prev); n.has(asset.id) ? n.delete(asset.id) : n.add(asset.id); return n; });
        } else if (e.altKey) { setLibDetail(asset); }
        else { setLibSelected(prev => { const n = new Set(prev); n.has(asset.id) ? n.delete(asset.id) : (n.clear(), n.add(asset.id)); return n; }); }
        libLastClick.current = asset.id;
    }

    async function handleLibExport(format: 'davinci' | 'fcpxml') {
        if (!libSelected.size) return;
        setLibExporting(true);
        try {
            const res = await fetch('http://localhost:3001/api/export', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(libSelected), format, timelineName: 'DreamPlay Timeline' }),
            });
            const blob = await res.blob();
            const cd = res.headers.get('Content-Disposition') ?? '';
            const fn = cd.match(/filename="(.+)"/);
            const filename = fn ? fn[1] : `timeline.${format === 'fcpxml' ? 'fcpxml' : 'xml'}`;
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
        } catch (e) { alert('Export failed — make sure the Media Indexer is running at localhost:3001'); console.error(e); }
        setLibExporting(false);
    }

    function handleLibCopyPaths() {
        const sel = libAssets.filter(a => libSelected.has(a.id));
        navigator.clipboard.writeText(sel.map(a => a.filePath).join('\n'));
        setLibCopyMsg('Copied!'); setTimeout(() => setLibCopyMsg(''), 2000);
    }

    const libSelectedAssets = libAssets.filter(a => libSelected.has(a.id));
    const libTotalDur = libSelectedAssets.reduce((s, a) => s + (a.durationSeconds ?? 0), 0);
    function libThumbUrl(asset: LibraryAsset) { return asset.thumbPath ? `/api/media-thumb?path=${encodeURIComponent(asset.thumbPath)}` : ''; }
    function libFmtDur(s: number | null) { if (!s) return ''; return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`; }
    function libFmtBytes(b: number) { if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`; if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`; return `${(b / 1e3).toFixed(0)} KB`; }
    const LIB_COLORS: Record<string, string> = { red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7', gray: '#6b7280' };
    const LIB_SUBJECTS = ['hands', 'piano-keys', 'piano-full', 'talking-head', 'lifestyle', 'product', 'abstract', 'mixed'];
    const LIB_PURPOSES = ['education', 'marketing', 'social-reel', 'product-demo', 'testimonial', 'b-roll'];
    const LIB_CAMPAIGNS = ['CEO Spotlight', 'Piano Comparison', 'Handspan Measurement', 'La Campanella', 'NAMM', 'Duel Piano', 'Other'];

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
    const [activeStrip, setActiveStrip] = useState<string | null>(null);
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
    const [jobs, setJobs] = useState<GenerationJob[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    useEffect(() => { sessionStorage.setItem('dp_jobs', JSON.stringify(jobs)); }, [jobs]);

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
    const [showOutputs, setShowOutputs] = useState(false);
    const [selectedOutput, setSelectedOutput] = useState<SavedOutput | null>(null);

    const loadSavedOutputs = useCallback(async () => {
        try {
            const res = await fetch('/api/save-generation');
            const data = await res.json();
            if (data.dates) setSavedOutputs(data.dates as Record<string, SavedOutput[]>);
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
        const activePrompt = enhancedPrompt || prompt;
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
                const res = await fetch(fmt.type === 'video' ? '/api/generate-video' : '/api/generate-image', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: activePrompt, modelId: job.modelId, aspectRatio: fmt.aspectRatio, width: fmt.width, height: fmt.height, refImagePaths, brandSuffix, prioritySuffix }),
                });
                const data = await res.json();
                const resultUrl = data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : data.videoUrl || undefined;
                if (resultUrl || data.operationName) {
                    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'done', resultUrl, completedAt: Date.now() } : j));
                    if (data.base64) saveGenerationToDisk(job, data.base64, data.mimeType || 'image/png', refImagePaths, brandSuffix);
                } else { throw new Error(data.error || 'No result'); }
            } catch (err) {
                setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: String(err) } : j));
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

    const reGenerateFromHistory = useCallback(async (entry: HistoryEntry) => {
        // Restore state
        setPrompt(entry.prompt);
        setEnhancedPrompt(entry.enhancedPrompt);
        setSelectedRefPaths(entry.refPaths.slice());
        setSelectedModel(entry.modelId);
        // Then trigger generation with the entry's data directly
        const formats = OUTPUT_FORMATS.filter(f => entry.formatLabels.includes(f.label));
        const model = MODEL_OPTIONS.find(m => m.id === entry.modelId);
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
                const res = await fetch(fmt.type === 'video' ? '/api/generate-video' : '/api/generate-image', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: activePrompt, modelId: job.modelId, aspectRatio: fmt.aspectRatio, refImagePaths: entry.refPaths, brandSuffix, prioritySuffix }),
                });
                const data = await res.json();
                const resultUrl = data.base64 ? `data:${data.mimeType || 'image/png'};base64,${data.base64}` : data.videoUrl || undefined;
                if (resultUrl || data.operationName) {
                    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'done', resultUrl, completedAt: Date.now() } : j));
                } else { throw new Error(data.error || 'No result'); }
            } catch (err) {
                setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: String(err) } : j));
            }
        }
        setIsGenerating(false);
    }, []);

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
    }, [selectedGridImage, imageMeta, activeStrip, previewImage]);

    // ─── Render helpers ───────────────────────────────────────────────────────────
    const selectedImageMeta = selectedGridImage ? getMeta(selectedGridImage) : null;

    return (
        <div className="app-shell">
            {/* ── TOOLBAR ── */}
            <header className="toolbar">
                <div className="toolbar-left">
                    <div className="toolbar-logo">
                        <div className="logo-mark">🎹</div>
                        <div><div className="logo-text">DreamPlay</div><div className="logo-sub">{activeTab === 'library' ? 'Media Library' : 'Asset Generator'}</div></div>
                    </div>
                    <div className="toolbar-divider" />
                    {/* Tab switcher */}
                    <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: '3px' }}>
                        <button
                            onClick={() => setActiveTab('generator')}
                            style={{ border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', background: activeTab === 'generator' ? 'var(--accent)' : 'transparent', color: activeTab === 'generator' ? '#fff' : 'var(--text-muted)' }}
                        >⚡ Generator</button>
                        <button
                            onClick={() => setActiveTab('library')}
                            style={{ border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', background: activeTab === 'library' ? '#c9a84c' : 'transparent', color: activeTab === 'library' ? '#000' : 'var(--text-muted)' }}
                        >🎬 Media Library {libStats.total > 0 && <span style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 4, padding: '0 4px', marginLeft: 4, fontSize: '0.6rem' }}>{libStats.total}</span>}</button>
                    </div>
                    <div className="toolbar-divider" />
                    <div className="api-status connected">
                        <span className="dot" />
                        API Ready
                    </div>
                </div>
                <div className="toolbar-center">
                    {activeTab === 'generator' && <div className="toolbar-breadcrumb">
                        <span>Library</span>
                        {!showAllFolders && selectedFolder && <><span className="sep">›</span><span className="current">{selectedFolder}</span></>}
                        {showAllFolders && <><span className="sep">›</span><span className="current">All Folders</span></>}
                        {(previewImage || currentPreviewJob) && <><span className="sep">›</span><span className="current">{currentPreviewJob ? currentPreviewJob.formatName : 'Preview'}</span></>}
                    </div>}
                    {activeTab === 'library' && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        {libStats.finals} finals · {libStats.highPriority} priority
                    </div>}
                </div>
                <div className="toolbar-right" />
            </header>

            {/* ── 3-PANEL ROW ── */}
            <div className="panels-row">

                {/* LEFT PANEL */}
                <aside className="left-panel">
                    <div className="left-panel-header">Library</div>
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
                                            <img src={path} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" onClick={() => toggleRefSelection(path)} />
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
                                                                if (out.prompt) setPrompt(out.prompt);
                                                                if (out.refImagePaths?.length) setSelectedRefPaths(out.refImagePaths.slice());
                                                            }}
                                                            title={out.prompt || out.formatLabel || 'Saved output'}>
                                                            <img src={out.path} alt="" className="output-thumb" loading="lazy" />
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

                {/* CENTER PANEL */}
                <main className="center-panel">
                    {currentPreviewJob ? (
                        /* Generated result preview */
                        <>
                            <div className="center-grid-header">
                                <button className="btn btn-ghost btn-sm" onClick={() => setActiveStrip(null)}>← Back</button>
                                <strong>{currentPreviewJob.formatName}</strong>
                                {currentPreviewJob.status === 'done' && currentPreviewJob.resultUrl && (
                                    <a href={currentPreviewJob.resultUrl} download className="btn btn-ghost btn-sm">↓ Download</a>
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
                    ) : previewImage ? (
                        /* Large product image preview */
                        <>
                            <div className="center-grid-header">
                                <button className="btn btn-ghost btn-sm" onClick={() => setPreviewImage(null)}>← Grid</button>
                                <strong style={{ fontSize: '0.72rem', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{previewImage.split('/').pop()}</strong>
                                <button className="btn btn-ghost btn-sm"
                                    style={{ color: selectedRefPaths.includes(previewImage) ? 'var(--accent)' : undefined }}
                                    onClick={() => toggleRefSelection(previewImage)}
                                    disabled={!selectedRefPaths.includes(previewImage) && selectedRefPaths.length >= 5}>
                                    {selectedRefPaths.includes(previewImage) ? '★ In References' : '☆ Add to References'}
                                </button>
                            </div>
                            <div className="center-preview">
                                <img src={previewImage} alt="Preview" />
                                <div className="preview-meta">{previewImage.split('/').pop()}</div>
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
                                                        onDoubleClick={() => setPreviewImage(img.path)}
                                                        title={img.name}>
                                                        {isVideoFile(img.path) ? (
                                                            <>
                                                                <video src={img.path} muted preload="metadata" playsInline
                                                                    onLoadedMetadata={e => { const v = e.target as HTMLVideoElement; v.currentTime = 0.5; handleVideoMeta(img.path, e); }} />
                                                                <div className="thumb-play-icon">▶</div>
                                                                {videoDurations[img.path] && <div className="thumb-duration">{videoDurations[img.path]}</div>}
                                                            </>
                                                        ) : (
                                                            <img src={img.path} alt={img.name} loading="lazy" />
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
                                                    onDoubleClick={() => setPreviewImage(img.path)}
                                                    title={img.name}>
                                                    {isVideoFile(img.path) ? (
                                                        <>
                                                            <video src={img.path} muted preload="metadata" playsInline
                                                                onLoadedMetadata={e => { const v = e.target as HTMLVideoElement; v.currentTime = 0.5; handleVideoMeta(img.path, e); }} />
                                                            <div className="thumb-play-icon">▶</div>
                                                            {videoDurations[img.path] && <div className="thumb-duration">{videoDurations[img.path]}</div>}
                                                        </>
                                                    ) : (
                                                        <img src={img.path} alt={img.name} loading="lazy" />
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

                {/* RIGHT PANEL */}
                <aside className="right-panel">
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
                                        <div className="strip-label">{job.formatLabel}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ));
                })()}
            </footer>

            {/* ── LIBRARY PANEL (replaces panels-row when active) ── */}
            {activeTab === 'library' && (
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
                    {/* Library sidebar */}
                    <aside style={{ width: 240, minWidth: 240, background: 'var(--lr-bg)', borderRight: '1px solid var(--lr-border)', overflowY: 'auto', padding: '10px 0 80px' }}>
                        {/* Search */}
                        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--lr-border)' }}>
                            <input style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--lr-border)', borderRadius: 6, padding: '7px 9px', color: 'var(--text-primary)', fontSize: '0.7rem', fontFamily: 'inherit', outline: 'none' }}
                                placeholder="Search assets…" value={libFilters.search}
                                onChange={e => setLibFilters(prev => ({ ...prev, search: e.target.value }))}
                                onFocus={e => (e.target.style.borderColor = '#c9a84c')}
                                onBlur={e => (e.target.style.borderColor = 'var(--lr-border)')}
                            />
                        </div>
                        {/* Quick filters */}
                        {[
                            { label: 'QUICK', filters: [['priority', 'high', '⚡ Priority'], ['finalStatus', 'final', '✅ Finals'], ['mediaType', 'video', '🎬 Video'], ['mediaType', 'image', '🖼 Photo']] as [string, string, string][] },
                            { label: 'HAND ZONE', filters: [['handZone', 'Zone A', 'Zone A (DS5.5)'], ['handZone', 'Zone B', 'Zone B (DS6.0)'], ['handZone', 'Zone C', 'Zone C (DS6.5)']] as [string, string, string][] },
                            { label: 'DS MODEL', filters: [['dsModel', 'DS5.5', 'DS5.5'], ['dsModel', 'DS6.0', 'DS6.0'], ['dsModel', 'DS6.5', 'DS6.5']] as [string, string, string][] },
                        ].map(({ label, filters }) => (
                            <div key={label} style={{ padding: '8px 12px', borderBottom: '1px solid var(--lr-border)' }}>
                                <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                    {filters.map(([k, v, l]) => {
                                        const isActive = (libFilters as Record<string, string>)[k] === v;
                                        return <button key={v} onClick={() => setLibFilter(k, v)}
                                            style={{ border: `1px solid ${isActive ? '#c9a84c' : 'var(--lr-border)'}`, borderRadius: 20, padding: '3px 9px', fontSize: '0.62rem', background: isActive ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.04)', color: isActive ? '#c9a84c' : 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>{l}</button>;
                                    })}
                                </div>
                            </div>
                        ))}
                        {/* Color labels */}
                        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--lr-border)' }}>
                            <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>COLOR LABEL</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {Object.entries(LIB_COLORS).map(([key, bg]) => (
                                    <button key={key} title={key}
                                        onClick={() => setLibFilter('colorLabel', key)}
                                        style={{ width: 20, height: 20, borderRadius: '50%', background: bg, border: libFilters.colorLabel === key ? '2px solid #fff' : '2px solid transparent', cursor: 'pointer', transform: libFilters.colorLabel === key ? 'scale(1.2)' : 'none', transition: 'transform 0.15s' }} />
                                ))}
                            </div>
                        </div>
                        {/* Subject, Purpose, Campaign */}
                        {[
                            { label: 'SUBJECT', key: 'subject', items: LIB_SUBJECTS },
                            { label: 'PURPOSE', key: 'purpose', items: LIB_PURPOSES },
                            { label: 'CAMPAIGN', key: 'campaign', items: LIB_CAMPAIGNS },
                            { label: 'STATUS', key: 'finalStatus', items: ['final', 'raw', 'intermediate'] },
                        ].map(({ label, key, items }) => (
                            <div key={key} style={{ padding: '8px 12px', borderBottom: '1px solid var(--lr-border)' }}>
                                <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                    {items.map(v => {
                                        const isActive = (libFilters as Record<string, string>)[key] === v;
                                        return <button key={v} onClick={() => setLibFilter(key, v)}
                                            style={{ border: `1px solid ${isActive ? '#c9a84c' : 'var(--lr-border)'}`, borderRadius: 20, padding: '3px 8px', fontSize: '0.6rem', background: isActive ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.04)', color: isActive ? '#c9a84c' : 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>{v}</button>;
                                    })}
                                </div>
                            </div>
                        ))}
                        {/* Reset */}
                        {Object.values(libFilters).some(v => v) && (
                            <div style={{ padding: '10px 12px' }}>
                                <button onClick={() => setLibFilters({ search: '', finalStatus: '', priority: '', subject: '', handZone: '', dsModel: '', purpose: '', campaign: '', shotType: '', colorLabel: '', mediaType: '', orientation: '' })}
                                    style={{ width: '100%', padding: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, color: '#ef4444', fontSize: '0.65rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                                    ✕ Clear All Filters
                                </button>
                            </div>
                        )}
                    </aside>

                    {/* Library main grid */}
                    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0a0a0b' }}>
                        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--lr-border)', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.7rem', color: 'var(--text-muted)', minHeight: 38 }}>
                            {libLoading ? 'Loading…' : libNotIndexed
                                ? '⚠ Not yet indexed — run pnpm ingest in the Media Indexer app'
                                : `${libTotal.toLocaleString()} assets`}
                            {libSelected.size > 0 && <span style={{ background: 'rgba(201,168,76,0.15)', border: '1px solid rgba(201,168,76,0.3)', color: '#c9a84c', borderRadius: 20, padding: '1px 8px', fontSize: '0.62rem' }}>{libSelected.size} selected</span>}
                            {libSelected.size > 0 && <button style={{ marginLeft: 'auto', border: '1px solid var(--lr-border)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', padding: '3px 8px', fontSize: '0.62rem', cursor: 'pointer' }} onClick={() => setLibSelected(new Set())}>Deselect All</button>}
                        </div>
                        <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8, alignContent: 'start' }}>
                            {libAssets.map(asset => {
                                const isSel = libSelected.has(asset.id);
                                const thumb = libThumbUrl(asset);
                                const keywords: string[] = (() => { try { return JSON.parse(asset.aiKeywords); } catch { return []; } })();
                                return (
                                    <div key={asset.id}
                                        onClick={e => handleLibClick(asset, e)}
                                        onDoubleClick={() => setLibDetail(asset)}
                                        style={{ background: 'var(--lr-bg)', border: `1.5px solid ${isSel ? '#c9a84c' : 'rgba(255,255,255,0.06)'}`, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', transition: 'border-color 0.15s, transform 0.15s', userSelect: 'none', position: 'relative', boxShadow: isSel ? '0 0 0 1px #c9a84c' : 'none' }}
                                    >
                                        <div style={{ width: '100%', aspectRatio: '16/9', background: 'rgba(255,255,255,0.04)', position: 'relative', overflow: 'hidden' }}>
                                            {thumb ? <img src={thumb} alt={asset.fileName} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} loading="lazy" />
                                                : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, opacity: 0.3 }}>{asset.mediaType === 'video' ? '🎬' : '🖼'}</div>}
                                            {asset.mediaType === 'video' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}><span style={{ fontSize: 20, opacity: 0.8 }}>▶</span></div>}
                                            {asset.durationSeconds && <span style={{ position: 'absolute', bottom: 4, right: 4, background: 'rgba(0,0,0,0.75)', color: '#fff', fontSize: '0.58rem', fontWeight: 600, padding: '1px 4px', borderRadius: 3 }}>{libFmtDur(asset.durationSeconds)}</span>}
                                            {asset.finalStatus === 'final' && <span style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(34,197,94,0.9)', color: '#fff', fontSize: '0.5rem', fontWeight: 700, padding: '1px 4px', borderRadius: 3, letterSpacing: '0.5px' }}>FINAL</span>}
                                            {asset.priority === 'high' && <span style={{ position: 'absolute', top: 4, right: 4, width: 9, height: 9, borderRadius: '50%', background: asset.colorLabel ? LIB_COLORS[asset.colorLabel] || '#ef4444' : '#ef4444', border: '1.5px solid rgba(255,255,255,0.5)', display: 'block' }} />}
                                            {isSel && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(201,168,76,0.2)', color: '#c9a84c', fontSize: 26, fontWeight: 700 }}>✓</div>}
                                        </div>
                                        <div style={{ padding: '6px 7px' }}>
                                            <div style={{ fontSize: '0.62rem', fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2 }} title={asset.fileName}>{asset.fileName}</div>
                                            <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', marginBottom: 4 }}>{asset.aiDescription || '—'}</div>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                                {asset.subject !== 'unknown' && <span style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, padding: '1px 4px', fontSize: '0.52rem', color: 'var(--text-muted)' }}>{asset.subject}</span>}
                                                {asset.handZone && <span style={{ background: 'rgba(74,158,255,0.1)', border: '1px solid rgba(74,158,255,0.3)', borderRadius: 3, padding: '1px 4px', fontSize: '0.52rem', color: '#4a9eff' }}>{asset.handZone}</span>}
                                                {asset.dsModel && <span style={{ background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 3, padding: '1px 4px', fontSize: '0.52rem', color: '#c9a84c' }}>{asset.dsModel}</span>}
                                                {keywords.slice(0, 1).map((k, i) => <span key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, padding: '1px 4px', fontSize: '0.52rem', color: 'var(--text-muted)', opacity: 0.6 }}>{k}</span>)}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {!libLoading && libAssets.length === 0 && !libNotIndexed && (
                                <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '80px 20px', textAlign: 'center' }}>
                                    <div style={{ fontSize: 48, opacity: 0.3 }}>🎹</div>
                                    <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-muted)' }}>No assets found</div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.6 }}>Try adjusting your filters</div>
                                </div>
                            )}
                            {libNotIndexed && (
                                <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '80px 20px', textAlign: 'center' }}>
                                    <div style={{ fontSize: 48 }}>⚙</div>
                                    <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-muted)' }}>Catalog not found yet</div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: 0.6, lineHeight: 1.8 }}>
                                        The ingestion agent is building the catalog.<br />
                                        Run: <code style={{ background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: 4 }}>pnpm ingest</code> in the Media Indexer app.
                                    </div>
                                </div>
                            )}
                        </div>
                    </main>

                    {/* Library export tray */}
                    {libSelected.size > 0 && (
                        <div style={{ position: 'fixed', bottom: 0, left: 240, right: 0, height: 60, background: 'var(--lr-bg)', borderTop: '1px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', zIndex: 20 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontWeight: 600, color: '#c9a84c', fontSize: 14 }}>{libSelected.size} clips selected</span>
                                {libTotalDur > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {libFmtDur(libTotalDur)} total</span>}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button style={{ border: '1px solid var(--lr-border)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', padding: '7px 12px', fontSize: '0.68rem', cursor: 'pointer' }} onClick={handleLibCopyPaths}>{libCopyMsg || '📋 Copy Paths'}</button>
                                <button disabled={libExporting} onClick={() => handleLibExport('fcpxml')}
                                    style={{ border: '1px solid var(--lr-border)', borderRadius: 6, background: 'rgba(255,255,255,0.06)', color: '#fff', padding: '7px 14px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer' }}>
                                    {libExporting ? '…' : '🎬 Export FCPXML'}
                                </button>
                                <button disabled={libExporting} onClick={() => handleLibExport('davinci')}
                                    style={{ border: 'none', borderRadius: 6, background: 'linear-gradient(135deg, #c9a84c, #8a6a1e)', color: '#fff', padding: '7px 14px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer' }}>
                                    {libExporting ? '…' : '🎨 Export DaVinci XML'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Library detail modal */}
                    {libDetail && (
                        <div onClick={() => setLibDetail(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
                            <div onClick={e => e.stopPropagation()} style={{ background: '#111114', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, width: 520, maxHeight: '82vh', overflowY: 'auto', position: 'relative' }}>
                                <button onClick={() => setLibDetail(null)} style={{ position: 'absolute', top: 12, right: 14, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)', width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', fontSize: 12 }}>✕</button>
                                {libDetail.thumbPath && <img src={libThumbUrl(libDetail)} alt={libDetail.fileName} style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: '14px 14px 0 0', display: 'block' }} />}
                                <div style={{ padding: 20 }}>
                                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, wordBreak: 'break-all' }}>{libDetail.fileName}</div>
                                    <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginBottom: 10, wordBreak: 'break-all', fontFamily: 'monospace' }}>{libDetail.filePath}</div>
                                    <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.7)', marginBottom: 14 }}>{libDetail.aiDescription}</div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 14 }}>
                                        {[['Status', libDetail.finalStatus], ['Priority', libDetail.priority], ['Subject', libDetail.subject], ['Hand Zone', libDetail.handZone ?? '—'], ['DS Model', libDetail.dsModel ?? '—'], ['Purpose', libDetail.purpose], ['Campaign', libDetail.campaign], ['Duration', libFmtDur(libDetail.durationSeconds)], ['Resolution', libDetail.width && libDetail.height ? `${libDetail.width}×${libDetail.height}` : '—'], ['File Size', libFmtBytes(libDetail.fileSize)], ['Color Grade', libDetail.colorGrade || '—'], ['Mood', libDetail.mood || '—']].map(([l, v]) => (
                                            <div key={l} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '6px 9px', display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                                                <span style={{ color: 'var(--text-muted)' }}>{l}</span>
                                                <span style={{ color: '#fff', fontWeight: 500 }}>{v}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <button onClick={() => { navigator.clipboard.writeText(libDetail.filePath); setLibCopyMsg('Copied!'); setTimeout(() => setLibCopyMsg(''), 1500); }}
                                        style={{ width: '100%', padding: 9, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '0.7rem' }}>
                                        {libCopyMsg || '📋 Copy File Path'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Generator panels (hidden when library is active) ── */}
            <style>{`
                .panels-row { display: ${activeTab === 'library' ? 'none' : 'flex'} !important; }
                footer.output-strip-bar { display: ${activeTab === 'library' ? 'none' : ''} !important; }
            `}</style>
        </div>
    );
}

