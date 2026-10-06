<script lang="ts">
    import { onMount } from 'svelte';
    import { getUtilizationColor } from '$lib/utils/colors';

    interface WeatherData { temperature: number; precipitation: number; cloudCover: number; isRaining: boolean; }
    interface CurrentData {
        status: 'live' | 'closed' | 'stale' | 'unavailable';
        percentage: number | null;
        level: string | null;
        lastUpdated: string | null;
        weather: WeatherData | null;
        message?: string;
    }
    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();
    let data = $state<CurrentData | null>(null);
    let loading = $state(true);
    let failed = $state(false);
    let now = $state(Date.now());
    let controller: AbortController | null = null;
    let sequence = 0;

    const statusText = $derived(failed ? 'Abruf fehlgeschlagen' : data?.status === 'unavailable' ? 'Keine aktuelle Messung' : data?.status === 'stale'
        ? 'Veralteter Messwert' : data?.status === 'closed' ? 'Geschlossen' : data?.status === 'live' ? 'Geöffnet' : 'Wird geladen …');
    const age = $derived(data?.lastUpdated ? Math.max(0, Math.floor((now - new Date(data.lastUpdated).getTime()) / 60000)) : null);
    const ageText = $derived(age === null ? 'Noch keine Messung' : age < 1 ? 'gerade eben' : age < 60 ? `vor ${age} Min.` : age < 1440 ? `vor ${Math.floor(age / 60)} Std. ${age % 60} Min.` : `vor ${Math.floor(age / 1440)} Tagen`);
    const percentage = $derived(failed || data?.status === 'unavailable' ? null : data?.percentage ?? null);
    const color = $derived(data?.status === 'live' && !failed ? getUtilizationColor(percentage) : 'var(--text-secondary)');
    function formatTime(timestamp: string | null) {
        return timestamp ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)) : '';
    }
    async function fetchData() {
        const request = ++sequence;
        controller?.abort();
        const active = new AbortController();
        controller = active;
        loading = true;
        try {
            const response = await fetch('/api/current', { signal: active.signal });
            if (!response.ok) throw new Error('unavailable');
            const result: CurrentData = await response.json();
            if (request !== sequence) return;
            data = result;
            failed = false;
            now = Date.now();
        } catch {
            if (request === sequence && !active.signal.aborted) failed = true;
        } finally {
            if (request === sequence) loading = false;
        }
    }
    onMount(() => {
        void fetchData();
        const interval = setInterval(() => { now = Date.now(); void fetchData(); }, 30000);
        return () => { clearInterval(interval); ++sequence; controller?.abort(); };
    });
    $effect(() => { if (refreshTrigger) void fetchData(); });
</script>

<section class="card current-card" aria-label="Aktuelle Studio-Auslastung" aria-busy={loading}>
    <div class="current-value" style={`color: ${color}`}>
        <span class="percentage">{percentage ?? '–'}<span class="percent-sign">%</span></span>
    </div>
    <div class="current-info" aria-live="polite">
        <div class="current-title"><h1>Jetzt</h1><span class="status" class:live={data?.status === 'live' && !failed}>{statusText}</span></div>
        <time datetime={data?.lastUpdated ?? undefined} title={formatTime(data?.lastUpdated ?? null)}>{data?.lastUpdated ? `Messung ${ageText}` : 'Noch keine Messung'}</time>
        {#if failed}<button class="retry" onclick={fetchData}>Erneut versuchen</button>{/if}
    </div>
</section>

<style>
    .current-card { display: flex; align-items: center; gap: 18px; padding: 14px 20px; }
    .current-value { flex-shrink: 0; }
    .percentage { font-size: 3rem; font-weight: 650; line-height: 1; letter-spacing: -.05em; font-variant-numeric: tabular-nums; }
    .percent-sign { font-size: 1.35rem; margin-left: 3px; font-weight: 500; }
    .current-info { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .current-title { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    h1 { font-size: .95rem; font-weight: 600; }
    .status { color: var(--text-secondary); font-size: .75rem; }
    .status.live::before { content: ''; display: inline-block; width: 5px; height: 5px; background: #22c55e; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    time { color: var(--text-secondary); font-size: .68rem; }
    .retry { color: var(--accent-primary); background: none; border: none; padding: 0; text-align: left; font-size: .7rem; }
    @media (max-width: 700px) {
        .current-card { gap: 14px; padding: 12px 14px; }
        .percentage { font-size: 2.8rem; } .percent-sign { font-size: 1.25rem; }
        .current-info { gap: 4px; } .current-title { gap: 8px; }
        h1 { font-size: .85rem; } .status { font-size: .7rem; } time { font-size: .64rem; }
    }
</style>
