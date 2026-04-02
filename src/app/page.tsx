'use client';

import { useState, useCallback, useRef } from 'react';
import { OUTPUT_FORMATS, MODEL_OPTIONS, CATEGORY_LABELS } from '@/lib/output-formats';
import { DEFAULT_BRAND_CONFIG, BRAND_STYLE_PRESETS } from '@/lib/brand-config';
import type { OutputFormat, ModelOption, GenerationJob, ReferenceFile } from '@/types';

// ─── Utility ─────────────────────────────────────────────────────────────────
function slugify(str: string) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}
function formatTime(ms: number) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ─── Format categories ───────────────────────────────────────────────────────
const CATEGORIES = ['social', 'ads', 'website', 'shopify'] as const;

export default function HomePage() {
    // API Key
    const [apiKey, setApiKey] = useState('');
    const [apiKeySaved, setApiKeySaved] = useState(false);

    // Selected formats
    const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
    const [openSections, setOpenSections] = useState<Set<string>>(new Set(['social', 'ads']));

    // Model
    const [selectedModel, setSelectedModel] = useState<string>('imagen-3-standard');

    // Prompt
    const [prompt, setPrompt] = useState('');
    const [enhancedPrompt, setEnhancedPrompt] = useState('');
    const [isEnhancing, setIsEnhancing] = useState(false);

    // Brand config
    const [brandTags, setBrandTags] = useState<string[]>(DEFAULT_BRAND_CONFIG.styleWords);
    const [activeBrandTags, setActiveBrandTags] = useState<Set<string>>(
        new Set(DEFAULT_BRAND_CONFIG.styleWords)
    );

    // References
    const [references, setReferences] = useState<ReferenceFile[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Jobs / Queue
    const [jobs, setJobs] = useState<GenerationJob[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);

    // Active tab
    const [activeTab, setActiveTab] = useState<'queue' | 'gallery'>('queue');

    // ─── Format selection ───────────────────────────────────────────────────────
    const toggleFormat = (id: string) => {
        setSelectedFormats(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSection = (cat: string) => {
        setOpenSections(prev => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat);
            else next.add(cat);
            return next;
        });
    };

    const selectAllInCategory = (cat: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const ids = OUTPUT_FORMATS.filter(f => f.category === cat).map(f => f.id);
        setSelectedFormats(prev => {
            const next = new Set(prev);
            const allSelected = ids.every(id => next.has(id));
            ids.forEach(id => (allSelected ? next.delete(id) : next.add(id)));
            return next;
        });
    };

    // ─── Brand tags ─────────────────────────────────────────────────────────────
    const toggleBrandTag = (tag: string) => {
        setActiveBrandTags(prev => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    };

    // ─── Reference upload ───────────────────────────────────────────────────────
    const handleFiles = useCallback((files: FileList) => {
        Array.from(files).forEach(file => {
            if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
            const reader = new FileReader();
            reader.onload = e => {
                const dataUrl = e.target?.result as string;
                const base64 = dataUrl.split(',')[1];
                setReferences(prev => [
                    ...prev,
                    {
                        id: `${Date.now()}-${Math.random()}`,
                        name: file.name,
                        type: file.type.startsWith('image/') ? 'image' : 'video',
                        dataUrl,
                        mimeType: file.type,
                        analysisResult: undefined,
                    },
                ]);
                // Auto-analyze image references
                if (file.type.startsWith('image/')) {
                    fetch('/api/enhance-prompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            mode: 'analyze-reference',
                            referenceBase64: base64,
                            referenceMimeType: file.type,
                        }),
                    })
                        .then(r => r.json())
                        .then(data => {
                            if (data.analysis) {
                                setReferences(prev =>
                                    prev.map(ref =>
                                        ref.dataUrl === dataUrl ? { ...ref, analysisResult: data.analysis } : ref
                                    )
                                );
                            }
                        })
                        .catch(() => { });
                }
            };
            reader.readAsDataURL(file);
        });
    }, []);

    const onDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
        },
        [handleFiles]
    );

    // ─── Prompt enhancement ─────────────────────────────────────────────────────
    const enhancePromptHandler = async () => {
        if (!prompt.trim()) return;
        setIsEnhancing(true);
        try {
            const brandContext = `${DEFAULT_BRAND_CONFIG.name}. Style: ${Array.from(activeBrandTags).join(', ')}. Colors: ${DEFAULT_BRAND_CONFIG.colors.join(', ')}. ${DEFAULT_BRAND_CONFIG.customPromptSuffix}`;
            const refAnalysis = references
                .filter(r => r.analysisResult)
                .map(r => r.analysisResult)
                .join('; ');

            const res = await fetch('/api/enhance-prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, brandContext, referenceAnalysis: refAnalysis }),
            });
            const data = await res.json();
            if (data.enhanced) setEnhancedPrompt(data.enhanced);
        } catch {
            // silently fail
        }
        setIsEnhancing(false);
    };

    // ─── Generation ─────────────────────────────────────────────────────────────
    const activePrompt = enhancedPrompt || prompt;
    const selectedFormatObjects = OUTPUT_FORMATS.filter(f => selectedFormats.has(f.id));
    const selectedModelObj = MODEL_OPTIONS.find(m => m.id === selectedModel)!;
    const totalCreditEstimate = selectedFormatObjects.reduce((sum, f) => sum + f.creditEstimate, 0);

    const startGeneration = async () => {
        if (!activePrompt.trim() || selectedFormatObjects.length === 0) return;
        setIsGenerating(true);
        setActiveTab('queue');

        // Create job entries
        const newJobs: GenerationJob[] = selectedFormatObjects.map(format => ({
            id: `${Date.now()}-${format.id}`,
            status: 'queued',
            format,
            model: selectedModelObj,
            prompt: activePrompt,
            createdAt: Date.now(),
        }));

        setJobs(prev => [...newJobs, ...prev]);

        // Process each job
        for (const job of newJobs) {
            const jobId = job.id;

            setJobs(prev =>
                prev.map(j => (j.id === jobId ? { ...j, status: 'processing' } : j))
            );

            try {
                const format = job.format;
                const modelObj = job.model;

                if (format.type === 'video') {
                    // Start video generation
                    const res = await fetch('/api/generate-video', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            prompt: job.prompt,
                            modelId: modelObj.apiModel,
                            aspectRatio: format.aspectRatio,
                            durationSeconds: 5,
                        }),
                    });
                    const data = await res.json();

                    if (!data.success || !data.operationName) {
                        throw new Error(data.error || 'Video generation failed to start');
                    }

                    const opName = data.operationName;
                    setJobs(prev =>
                        prev.map(j => (j.id === jobId ? { ...j, operationName: opName } : j))
                    );

                    // Poll for completion
                    let done = data.done;
                    let pollData: { done: boolean; videoUri?: string; mimeType?: string; error?: string } = data;
                    while (!done) {
                        await new Promise(r => setTimeout(r, 8000));
                        const pollRes = await fetch('/api/job-status', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ operationName: opName }),
                        });
                        pollData = await pollRes.json();
                        done = pollData.done;
                    }

                    if (pollData.error) throw new Error(pollData.error);

                    setJobs(prev =>
                        prev.map(j =>
                            j.id === jobId
                                ? { ...j, status: 'done', resultUrl: pollData.videoUri, mimeType: 'video/mp4', completedAt: Date.now() }
                                : j
                        )
                    );
                } else {
                    // Image generation
                    const res = await fetch('/api/generate-image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            prompt: job.prompt,
                            modelId: modelObj.apiModel,
                            aspectRatio: format.aspectRatio,
                        }),
                    });
                    const data = await res.json();

                    if (!data.success) throw new Error(data.error || 'Image generation failed');

                    setJobs(prev =>
                        prev.map(j =>
                            j.id === jobId
                                ? { ...j, status: 'done', resultBase64: data.base64, mimeType: data.mimeType, completedAt: Date.now() }
                                : j
                        )
                    );
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setJobs(prev =>
                    prev.map(j => (j.id === jobId ? { ...j, status: 'error', error: msg } : j))
                );
            }
        }

        setIsGenerating(false);
    };

    // ─── Download ───────────────────────────────────────────────────────────────
    const downloadAsset = (job: GenerationJob) => {
        const ext = job.format.type === 'video' ? 'mp4' : 'png';
        const filename = `${slugify(job.prompt)}_${job.format.id}_${Date.now()}.${ext}`;

        if (job.resultBase64) {
            const link = document.createElement('a');
            link.href = `data:${job.mimeType};base64,${job.resultBase64}`;
            link.download = filename;
            link.click();
        } else if (job.resultUrl) {
            const link = document.createElement('a');
            link.href = job.resultUrl;
            link.download = filename;
            link.target = '_blank';
            link.click();
        }
    };

    const downloadAll = () => {
        jobs.filter(j => j.status === 'done').forEach(j => downloadAsset(j));
    };

    // ─── Completed jobs ──────────────────────────────────────────────────────────
    const completedJobs = jobs.filter(j => j.status === 'done');

    // ─── API key save ────────────────────────────────────────────────────────────
    const saveApiKey = () => {
        if (apiKey.trim()) setApiKeySaved(true);
    };

    // ─── Render ──────────────────────────────────────────────────────────────────
    return (
        <>
            {/* HEADER */}
            <header className="header">
                <div className="container">
                    <div className="header-inner">
                        <div className="logo">
                            <div className="logo-mark">🎹</div>
                            <div>
                                <div className="logo-text">DreamPlay</div>
                                <div className="logo-sub">Asset Generator</div>
                            </div>
                        </div>
                        <div className="header-right">
                            <div className={`api-status ${apiKeySaved ? 'connected' : ''}`}>
                                <span className="dot" />
                                {apiKeySaved ? 'API Connected' : 'No API Key'}
                            </div>
                            {completedJobs.length > 0 && (
                                <button className="btn btn-secondary btn-sm" onClick={downloadAll}>
                                    ⬇ Download All ({completedJobs.length})
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </header>

            {/* MAIN */}
            <div className="container">
                {/* API Key Banner */}
                {!apiKeySaved && (
                    <div style={{ padding: '1rem 0' }}>
                        <div className="api-banner fade-in">
                            <div className="api-banner-text">
                                <div className="api-banner-title">🔑 Add Your Free Gemini API Key</div>
                                <div className="api-banner-desc">
                                    Get a free key at{' '}
                                    <a href="https://aistudio.google.com" target="_blank" rel="noreferrer">
                                        aistudio.google.com
                                    </a>{' '}
                                    → "Get API Key". Free tier includes Imagen 3 + Gemini. Veo video requires Cloud credits.
                                </div>
                            </div>
                            <div className="api-key-input-row" style={{ minWidth: 340 }}>
                                <input
                                    className="api-key-input"
                                    type="password"
                                    placeholder="AIza..."
                                    value={apiKey}
                                    onChange={e => setApiKey(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && saveApiKey()}
                                />
                                <button className="btn btn-primary btn-sm" onClick={saveApiKey}>
                                    Save
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                <div className="pipeline-grid">
                    {/* ── SIDEBAR ── */}
                    <aside className="sidebar">
                        {/* Output Formats */}
                        <div className="card">
                            <div className="card-header">
                                <span className="card-title">📦 Output Formats</span>
                                <span className="section-count">{selectedFormats.size} selected</span>
                            </div>
                            <div className="scrollable">
                                {CATEGORIES.map(cat => {
                                    const formats = OUTPUT_FORMATS.filter(f => f.category === cat);
                                    const isOpen = openSections.has(cat);
                                    const selectedInCat = formats.filter(f => selectedFormats.has(f.id)).length;
                                    return (
                                        <div key={cat}>
                                            <button
                                                className="section-toggle"
                                                onClick={() => toggleSection(cat)}
                                                id={`section-${cat}`}
                                            >
                                                <span className="section-label">
                                                    <span>{CATEGORY_LABELS[cat]}</span>
                                                    {selectedInCat > 0 && (
                                                        <span className="section-count">{selectedInCat}/{formats.length}</span>
                                                    )}
                                                </span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    <button
                                                        className="select-all-btn"
                                                        onClick={e => selectAllInCategory(cat, e)}
                                                    >
                                                        {formats.every(f => selectedFormats.has(f.id)) ? 'Deselect all' : 'Select all'}
                                                    </button>
                                                    <span className={`chevron ${isOpen ? 'open' : ''}`}>▼</span>
                                                </div>
                                            </button>
                                            {isOpen && (
                                                <div className="section-items fade-in">
                                                    {formats.map(format => {
                                                        const checked = selectedFormats.has(format.id);
                                                        return (
                                                            <label
                                                                key={format.id}
                                                                className={`format-item ${checked ? 'checked' : ''}`}
                                                                htmlFor={`fmt-${format.id}`}
                                                            >
                                                                <input
                                                                    id={`fmt-${format.id}`}
                                                                    type="checkbox"
                                                                    checked={checked}
                                                                    onChange={() => toggleFormat(format.id)}
                                                                />
                                                                <div className="format-checkbox">
                                                                    <span className="format-checkbox-inner">✓</span>
                                                                </div>
                                                                <div className="format-info">
                                                                    <div className="format-name">{format.label}</div>
                                                                    <div className="format-meta">
                                                                        {format.width}×{format.height}
                                                                        {format.duration && ` · ${format.duration}`}
                                                                        {format.notes && ` · ${format.notes}`}
                                                                    </div>
                                                                </div>
                                                                <span className={`format-type-badge ${format.type}`}>
                                                                    {format.type === 'image' ? '🖼' : '🎬'}
                                                                </span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            <div className="divider" style={{ margin: 0 }} />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Credit Estimator */}
                        {selectedFormats.size > 0 && (
                            <div className="credit-bar fade-in">
                                <span className="credit-icon">💳</span>
                                <span className="credit-label">Estimated:</span>
                                <strong>~{totalCreditEstimate} credits</strong>
                                <span className="credit-label" style={{ marginLeft: 'auto' }}>
                                    {selectedFormatObjects.filter(f => f.type === 'image').length} photos,{' '}
                                    {selectedFormatObjects.filter(f => f.type === 'video').length} videos
                                </span>
                            </div>
                        )}
                    </aside>

                    {/* ── MAIN AREA ── */}
                    <main className="main-area">
                        {/* Model Selector */}
                        <div className="card">
                            <div className="card-header">
                                <span className="card-title">🤖 Generation Model</span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                    Free tier available
                                </span>
                            </div>
                            <div className="card-body">
                                <div className="model-grid">
                                    {MODEL_OPTIONS.filter(m => m.type !== 'text').map(model => (
                                        <div
                                            key={model.id}
                                            className={`model-card ${selectedModel === model.id ? 'selected' : ''}`}
                                            onClick={() => setSelectedModel(model.id)}
                                            id={`model-${model.id}`}
                                        >
                                            {selectedModel === model.id && (
                                                <div className="model-selected-check">✓</div>
                                            )}
                                            <div className="model-card-name">{model.name}</div>
                                            <div className="model-card-desc">{model.description}</div>
                                            <div className="model-card-badges">
                                                <span className={`model-badge ${model.tier}`}>
                                                    {model.tier === 'free' ? '✓ Free' : '💳 Paid'}
                                                </span>
                                                <span className={`model-badge ${model.type}`}>{model.type}</span>
                                                <span className="model-badge fast">{model.quality}</span>
                                            </div>
                                            <div style={{ fontSize: '0.68rem', color: 'var(--gold)', marginTop: '0.5rem' }}>
                                                {model.creditCost}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Reference Uploader */}
                        <div className="card">
                            <div className="card-header">
                                <span className="card-title">📁 Reference Images / Videos</span>
                                {references.length > 0 && (
                                    <button
                                        className="btn-ghost"
                                        onClick={() => setReferences([])}
                                        style={{ fontSize: '0.7rem', color: 'var(--accent-red)' }}
                                    >
                                        Clear all
                                    </button>
                                )}
                            </div>
                            <div className="card-body">
                                <div
                                    className={`upload-zone ${isDragOver ? 'drag-over' : ''}`}
                                    onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
                                    onDragLeave={() => setIsDragOver(false)}
                                    onDrop={onDrop}
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <div className="upload-icon">📂</div>
                                    <div className="upload-text">
                                        <strong>Drop photos & videos here</strong>
                                    </div>
                                    <div className="upload-subtext">
                                        JPG, PNG, WebP, MP4 · Gemini analyzes them to match your brand style
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        multiple
                                        accept="image/*,video/*"
                                        className="upload-input"
                                        onChange={e => e.target.files && handleFiles(e.target.files)}
                                        style={{ display: 'none' }}
                                    />
                                </div>
                                {references.length > 0 && (
                                    <div className="reference-grid">
                                        {references.map(ref => (
                                            <div key={ref.id} className="reference-thumb">
                                                <img
                                                    src={ref.dataUrl}
                                                    alt={ref.name}
                                                    title={ref.analysisResult || ref.name}
                                                />
                                                <button
                                                    className="remove-btn"
                                                    onClick={() => setReferences(prev => prev.filter(r => r.id !== ref.id))}
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {references.some(r => r.analysisResult) && (
                                    <div className="hint" style={{ marginTop: '0.75rem' }}>
                                        ✓ Gemini analyzed {references.filter(r => r.analysisResult).length} reference(s) — style descriptors will be applied to your prompt.
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Prompt Builder */}
                        <div className="card">
                            <div className="card-header">
                                <span className="card-title">✍️ Prompt Builder</span>
                            </div>
                            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {/* Brand tags */}
                                <div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                        Brand Style
                                    </div>
                                    <div className="brand-tags">
                                        {brandTags.map(tag => (
                                            <button
                                                key={tag}
                                                className={`brand-tag ${activeBrandTags.has(tag) ? 'active' : ''}`}
                                                onClick={() => toggleBrandTag(tag)}
                                            >
                                                {tag}
                                            </button>
                                        ))}
                                        {BRAND_STYLE_PRESETS.map(preset => (
                                            <button
                                                key={preset.label}
                                                className="brand-tag"
                                                onClick={() => {
                                                    setBrandTags(prev => {
                                                        const all = [...new Set([...prev, ...preset.words])];
                                                        return all;
                                                    });
                                                    setActiveBrandTags(prev => {
                                                        const next = new Set(prev);
                                                        preset.words.forEach(w => next.add(w));
                                                        return next;
                                                    });
                                                }}
                                                style={{ borderStyle: 'dashed' }}
                                            >
                                                + {preset.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Prompt input */}
                                <div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                        Your Prompt
                                    </div>
                                    <textarea
                                        className="prompt-textarea"
                                        placeholder="e.g. DreamPlay piano on a midnight-lit stage, golden keys catching spotlights, cinematic lens flare..."
                                        value={prompt}
                                        onChange={e => { setPrompt(e.target.value); setEnhancedPrompt(''); }}
                                        id="prompt-input"
                                    />
                                </div>

                                {/* Enhance button */}
                                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={enhancePromptHandler}
                                        disabled={isEnhancing || !prompt.trim()}
                                    >
                                        {isEnhancing ? (
                                            <><span className="spinner" /> Enhancing...</>
                                        ) : (
                                            '✨ Enhance with Gemini'
                                        )}
                                    </button>
                                    {enhancedPrompt && (
                                        <button className="btn-ghost" onClick={() => setEnhancedPrompt('')}>
                                            Use original
                                        </button>
                                    )}
                                </div>

                                {/* Enhanced prompt display */}
                                {enhancedPrompt && (
                                    <div className="prompt-enhanced fade-in">
                                        <span className="prompt-enhanced-label">✨ AI Enhanced</span>
                                        {enhancedPrompt}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Results Area */}
                        {jobs.length > 0 && (
                            <div className="card fade-in">
                                <div className="tabs">
                                    <button
                                        className={`tab ${activeTab === 'queue' ? 'active' : ''}`}
                                        onClick={() => setActiveTab('queue')}
                                    >
                                        Queue ({jobs.length})
                                    </button>
                                    <button
                                        className={`tab ${activeTab === 'gallery' ? 'active' : ''}`}
                                        onClick={() => setActiveTab('gallery')}
                                    >
                                        Gallery ({completedJobs.length})
                                    </button>
                                </div>

                                {activeTab === 'queue' && (
                                    <div className="card-body">
                                        <div className="queue-list">
                                            {jobs.map(job => (
                                                <div key={job.id} className={`queue-item ${job.status}`}>
                                                    <div className="queue-thumb">
                                                        {job.status === 'done' && job.resultBase64 ? (
                                                            <img
                                                                src={`data:${job.mimeType};base64,${job.resultBase64}`}
                                                                alt={job.format.label}
                                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                                            />
                                                        ) : (
                                                            <span>{job.format.type === 'video' ? '🎬' : '🖼'}</span>
                                                        )}
                                                    </div>
                                                    <div className="queue-info">
                                                        <div className="queue-name">{job.format.label}</div>
                                                        <div className="queue-meta">
                                                            {job.format.width}×{job.format.height} · {job.model.name}
                                                            {job.completedAt && ` · ${formatTime(job.completedAt - job.createdAt)}`}
                                                        </div>
                                                        {job.error && (
                                                            <div style={{ fontSize: '0.68rem', color: 'var(--accent-red)', marginTop: 2 }}>
                                                                {job.error}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className={`queue-status ${job.status}`}>
                                                        {job.status === 'queued' && '⏳ Queued'}
                                                        {job.status === 'processing' && (
                                                            <><span className="spinner" /> Processing</>
                                                        )}
                                                        {job.status === 'done' && (
                                                            <>
                                                                ✓ Done
                                                                <button
                                                                    className="btn btn-secondary btn-sm"
                                                                    style={{ marginLeft: '0.5rem' }}
                                                                    onClick={() => downloadAsset(job)}
                                                                >
                                                                    ⬇
                                                                </button>
                                                            </>
                                                        )}
                                                        {job.status === 'error' && '✗ Error'}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'gallery' && (
                                    <div className="card-body">
                                        {completedJobs.length === 0 ? (
                                            <div className="empty-state">
                                                <div className="empty-icon">🎨</div>
                                                <div className="empty-title">No completed assets yet</div>
                                                <div className="empty-desc">Assets will appear here as they finish generating</div>
                                            </div>
                                        ) : (
                                            <div className="gallery-grid">
                                                {completedJobs.map(job => (
                                                    <div key={job.id} className="gallery-item">
                                                        <div className="gallery-preview">
                                                            {job.resultBase64 && (
                                                                <img
                                                                    src={`data:${job.mimeType};base64,${job.resultBase64}`}
                                                                    alt={job.format.label}
                                                                />
                                                            )}
                                                            {job.resultUrl && (
                                                                <video
                                                                    src={job.resultUrl}
                                                                    autoPlay
                                                                    muted
                                                                    loop
                                                                    playsInline
                                                                />
                                                            )}
                                                            <div className="gallery-overlay">
                                                                <button className="gallery-dl-btn" onClick={() => downloadAsset(job)}>
                                                                    ⬇ Download
                                                                </button>
                                                            </div>
                                                        </div>
                                                        <div className="gallery-label">
                                                            <div className="name">{job.format.label}</div>
                                                            <div className="meta">
                                                                {job.format.width}×{job.format.height} · {job.model.name}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Empty queue state */}
                        {jobs.length === 0 && (
                            <div className="card" style={{ border: '1px dashed var(--border)' }}>
                                <div className="empty-state">
                                    <div className="empty-icon">🚀</div>
                                    <div className="empty-title">Ready to generate</div>
                                    <div className="empty-desc">
                                        Select output formats → choose a model → write a prompt → hit Generate
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* ACTION BAR */}
                        <div className="action-bar">
                            <div className="action-summary">
                                <div className="action-count">
                                    {selectedFormats.size === 0
                                        ? 'Select formats to begin'
                                        : `${selectedFormats.size} asset${selectedFormats.size !== 1 ? 's' : ''} queued`}
                                </div>
                                <div className="action-detail">
                                    {selectedFormats.size > 0 && (
                                        <>
                                            <span style={{ color: 'var(--accent-blue)' }}>
                                                📸 {selectedFormatObjects.filter(f => f.type === 'image').length} photos
                                            </span>
                                            {' · '}
                                            <span style={{ color: 'var(--gold)' }}>
                                                🎬 {selectedFormatObjects.filter(f => f.type === 'video').length} videos
                                            </span>
                                            {' · '}
                                            <span>~{totalCreditEstimate} credits</span>
                                        </>
                                    )}
                                </div>
                            </div>
                            <div className="action-buttons">
                                {selectedFormats.size > 0 && (
                                    <button
                                        className="btn btn-ghost"
                                        onClick={() => setSelectedFormats(new Set())}
                                    >
                                        Clear
                                    </button>
                                )}
                                <button
                                    className="btn btn-primary"
                                    disabled={
                                        selectedFormats.size === 0 || !activePrompt.trim() || isGenerating
                                    }
                                    onClick={startGeneration}
                                    id="generate-btn"
                                >
                                    {isGenerating ? (
                                        <><span className="spinner" style={{ borderTopColor: '#000', borderColor: 'rgba(0,0,0,0.3)' }} /> Generating...</>
                                    ) : (
                                        '⚡ Generate Assets'
                                    )}
                                </button>
                            </div>
                        </div>
                    </main>
                </div>
            </div>
        </>
    );
}
