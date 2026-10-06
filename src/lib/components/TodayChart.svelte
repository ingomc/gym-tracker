<script lang="ts">
    import { onMount } from 'svelte';
    import { Chart, registerables, type ChartDataset } from 'chart.js';
    import DatePicker from './DatePicker.svelte';
    import { analytics } from '$lib/utils/analytics';
    import { studioDateString, studioOpeningHours, addStudioDays } from '$lib/utils/studio-time';
    import { getUtilizationColorRGBA } from '$lib/utils/colors';
    import '$lib/utils/tooltip-position';

    Chart.register(...registerables);
    interface Reading { time: string; timestamp: string; hour: number; minute: number; percentage: number; level: string; }
    interface ReadingData { date: string; dateFormatted: string; isToday: boolean; allTimeMax: number; readings: Reading[]; count: number; }
    interface ForecastWeather { temperature: number; precipitation: number; cloudCover: number; fetchedAt: string; targetAt: string; provider: 'open-meteo'; source: 'forecast'; }
    interface Prediction { hour: number; minute: number; percentage: number; targetAt?: string; lower?: number | null; upper?: number | null; weather?: ForecastWeather | null; }
    interface PredictionData {
        date: string; weekday: number; isHoliday: boolean; holidayName: string | null; predictions: Prediction[];
        status?: 'ready' | 'training' | 'unavailable'; issuedAt?: string; trainedThrough?: string; modelVersion?: string;
        intervalCoverage?: number; openingHours?: { startTime: string; endTime: string }; error?: string;
    }
    interface Slot { label: string; actual: number | null; prediction: number | null; lower: number | null; upper: number | null; timestamp: string | null; weather: ForecastWeather | null; }
    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();
    let data = $state<ReadingData | null>(null);
    let predictions = $state<PredictionData | null>(null);
    let selectedDate = $state(studioDateString());
    let today = $state(studioDateString());
    let followingToday = true;
    let loading = $state(true);
    let error = $state(false);
    let predictionFailed = $state(false);
    let selectedSlotIndex = $state<number | null>(null);
    let showDetails = $state(false);
    let chartCanvas = $state<HTMLCanvasElement | null>(null);
    let datePicker: DatePicker;
    let chart: Chart<'bar' | 'line', (number | null)[], string> | null = null;
    let controller: AbortController | null = null;
    let sequence = 0;
    const mode = $derived(selectedDate === today ? 'Heute' : selectedDate > today ? 'Prognose' : 'Archiv');
    const hasForecast = $derived(Boolean(predictions?.predictions.length));
    const hasInterval = $derived(predictions?.predictions.some((entry) => entry.lower != null && entry.upper != null) ?? false);
    const formattedDate = $derived(formatDate(selectedDate));
    const slots = $derived.by((): Slot[] => {
        const hours = studioOpeningHours(selectedDate);
        const parseTime = (value: string | undefined, fallback: number) => value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : fallback * 60;
        const start = parseTime(predictions?.openingHours?.startTime, hours.startHour);
        const end = parseTime(predictions?.openingHours?.endTime, hours.endHour);
        const readings = new Map<number, Reading>();
        for (const reading of data?.readings ?? []) readings.set(Math.floor((reading.hour * 60 + reading.minute) / 15), reading);
        const predicted = new Map((predictions?.predictions ?? []).map((entry) => [Math.floor((entry.hour * 60 + entry.minute) / 15), entry]));
        // Preserve real readings outside the current regular schedule when viewing the archive.
        const first = Math.min(Math.floor(start / 15), ...readings.keys());
        const last = Math.max(Math.ceil(end / 15) - 1, ...readings.keys());
        return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
            const slot = index + first;
            const reading = readings.get(slot);
            const prediction = predicted.get(slot);
            return {
                label: `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`,
                actual: reading?.percentage ?? null, prediction: prediction?.percentage ?? null,
                lower: prediction?.lower ?? null, upper: prediction?.upper ?? null, timestamp: reading?.timestamp ?? null, weather: prediction?.weather ?? null,
            };
        });
    });
    const selectedSlot = $derived(selectedSlotIndex !== null ? slots[selectedSlotIndex] ?? null : null);
    const visibleMax = $derived(Math.min(100, Math.max(20, Math.ceil(Math.max(0, ...slots.flatMap((slot) => [slot.actual ?? 0, slot.prediction ?? 0, slot.upper ?? 0])) / 10) * 10 + 10)));
    const readingCount = $derived(slots.filter((slot) => slot.actual !== null).length);
    const selectedIsEmpty = $derived(!loading && !error && readingCount === 0 && !hasForecast);
    const predictionMessage = $derived(predictions?.status === 'training'
        ? 'Prognose wird vorbereitet.'
        : predictionFailed || !hasForecast
            ? mode === 'Archiv' ? 'Keine historische Prognose gespeichert.' : 'Prognose derzeit nicht verfügbar.'
            : null);

    function formatDate(date: string) { return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); }
    function formatTime(timestamp: string) { return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)); }
    function percent(value: number | null) { return value === null ? '–' : `${Number(value.toFixed(1)).toLocaleString('de-DE')} %`; }
    function difference(slot: Slot) { return slot.actual !== null && slot.prediction !== null ? `${slot.actual - slot.prediction > 0 ? '+' : ''}${Number((slot.actual - slot.prediction).toFixed(1)).toLocaleString('de-DE')} Prozentpunkte` : null; }
    function details(slot: Slot): string[] {
        return [
            `Messwert: ${slot.actual === null ? 'Keine Messung' : percent(slot.actual)}`,
            `Prognose: ${slot.prediction === null ? 'Nicht verfügbar' : percent(slot.prediction)}`,
            ...(difference(slot) ? [`Abweichung: ${difference(slot)}`] : []),
            ...(slot.lower !== null && slot.upper !== null ? [`80-%-Prognoseband: ${percent(slot.lower)} – ${percent(slot.upper)}`] : []),
            ...(slot.weather ? [`Wetter: ${slot.weather.temperature.toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C · ${slot.weather.precipitation.toLocaleString('de-DE', { maximumFractionDigits: 1 })} mm/h`] : []),
            ...(slot.timestamp ? [`Gemessen um ${formatTime(slot.timestamp)} Uhr`] : []),
        ];
    }
    async function fetchData(date: string, background = false) {
        const request = ++sequence;
        controller?.abort();
        const active = new AbortController(); controller = active;
        selectedDate = date; today = studioDateString(); loading = true; error = false;
        if (!background) { data = null; predictions = null; selectedSlotIndex = null; }
        const readPredictions = async (): Promise<PredictionData | null> => {
            try {
                const response = await fetch(`/api/predictions?date=${date}`, { signal: active.signal });
                if (!response.ok && response.status !== 503) throw new Error('prediction');
                return await response.json();
            } catch { return null; }
        };
        try {
            const [response, predicted] = await Promise.all([fetch(`/api/today-raw?date=${date}`, { signal: active.signal }), readPredictions()]);
            if (!response.ok) throw new Error('readings');
            const result: ReadingData = await response.json();
            if (request !== sequence || active.signal.aborted) return;
            data = result; predictions = predicted; predictionFailed = predicted === null;
        } catch {
            if (request === sequence && !active.signal.aborted) error = true;
        } finally { if (request === sequence) loading = false; }
    }
    function selectDate(date: string) {
        followingToday = date === studioDateString(); analytics.dateChange(date);
        void fetchData(date);
    }
    function goToday() { followingToday = true; selectDate(studioDateString()); }
    function updateChart() {
        if (!chartCanvas) return;
        const datasets: ChartDataset<'bar' | 'line', (number | null)[]>[] = [];
        if (hasInterval) {
            datasets.push({ type: 'line', label: 'Obere Grenze', data: slots.map((slot) => slot.upper), borderWidth: 0, pointRadius: 0, pointHitRadius: 0, fill: '+1', backgroundColor: 'rgba(164, 172, 190, 0.10)', spanGaps: false, order: 3 });
            datasets.push({ type: 'line', label: 'Untere Grenze', data: slots.map((slot) => slot.lower), borderWidth: 0, pointRadius: 0, pointHitRadius: 0, fill: false, spanGaps: false, order: 3 });
        }
        if (hasForecast) datasets.push({
            type: 'line', label: 'Prognose', data: slots.map((slot) => slot.prediction),
            borderColor: '#a8b1c2', borderWidth: 2, borderDash: [5, 4],
            segment: { borderColor: ({ p0, p1 }) => getUtilizationColorRGBA(p0.parsed.y !== null && p1.parsed.y !== null ? (p0.parsed.y + p1.parsed.y) / 2 : null, 1) },
            pointBackgroundColor: slots.map((slot) => getUtilizationColorRGBA(slot.prediction, 1)),
            pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: .25, spanGaps: false, order: 1,
        });
        datasets.push({ type: 'bar', label: 'Messwert', data: slots.map((slot) => slot.actual), backgroundColor: slots.map((slot) => getUtilizationColorRGBA(slot.actual, .82)), hoverBackgroundColor: slots.map((slot) => getUtilizationColorRGBA(slot.actual, 1)), borderRadius: 2, borderSkipped: false, barPercentage: .78, categoryPercentage: .95, order: 2 });
        if (chart) {
            chart.data = { labels: slots.map((slot) => slot.label), datasets };
            if (chart.options.scales?.y) chart.options.scales.y.max = visibleMax;
            chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
            chart.update('none');
            return;
        }
        chart = new Chart<'bar' | 'line', (number | null)[], string>(chartCanvas, {
            type: 'bar', data: { labels: slots.map((slot) => slot.label), datasets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { mode: 'index', intersect: false, axis: 'x' },
                onClick: (_event, elements) => { if (elements[0]) { selectedSlotIndex = elements[0].index; showDetails = true; } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        position: 'aboveBelowPoint',
                        backgroundColor: '#242832', borderColor: '#4a5160', borderWidth: 1, titleColor: '#f2f4f8', bodyColor: '#c9ced9', cornerRadius: 6, displayColors: false,
                        caretSize: 5, caretPadding: 5,
                        padding: ({ chart }) => chart.height <= 240 ? 6 : 10,
                        titleFont: { size: 12, weight: 600, lineHeight: 1.1 }, titleMarginBottom: 4,
                        bodyFont: ({ chart }) => ({ size: chart.height <= 240 ? 11 : 12, lineHeight: 1 }),
                        bodySpacing: ({ chart }) => chart.height <= 240 ? 1 : 3,
                        filter: (item) => (item.dataset.label === 'Messwert' || item.dataset.label === 'Prognose') && typeof item.raw === 'number' && Number.isFinite(item.raw),
                        callbacks: {
                            title: (items) => items[0] ? `${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${selectedDate}T12:00:00Z`))} · ${slots[items[0].dataIndex]?.label} Uhr` : '',
                            label: () => '',
                            afterBody: (items) => items[0] && slots[items[0].dataIndex] ? details(slots[items[0].dataIndex]) : [],
                        },
                    },
                },
                scales: {
                    y: { beginAtZero: true, max: visibleMax, border: { display: false }, grid: { color: '#ffffff09' }, ticks: { color: '#959daa', font: { size: 10 }, padding: 5, maxTicksLimit: 5, callback: (value) => `${value} %` } },
                    x: { border: { display: false }, grid: { display: false }, ticks: { color: '#959daa', maxRotation: 0, autoSkip: false, font: { size: 10 }, padding: 7, callback: function (_value, index) { const label = this.getLabelForValue(index); return label?.endsWith(':00') && Number(label.slice(0, 2)) % 2 === 0 ? label : ''; } } },
                },
            },
        });
    }
    $effect(() => { updateChart(); });
    let lastRefresh: Date | null = null;
    $effect(() => { if (refreshTrigger && refreshTrigger !== lastRefresh) { lastRefresh = refreshTrigger; void fetchData(selectedDate, true); datePicker?.refresh(); } });
    onMount(() => {
        void fetchData(studioDateString());
        const interval = setInterval(() => {
            const currentToday = studioDateString();
            const nextDate = followingToday ? currentToday : selectedDate;
            void fetchData(nextDate, nextDate === selectedDate); datePicker?.refresh();
        }, 60000);
        return () => {
            clearInterval(interval); ++sequence; controller?.abort(); chart?.destroy(); chart = null;
        };
    });
</script>

<section class="card chart-card" aria-labelledby="chart-heading" aria-busy={loading}>
    <div class="chart-header">
        <h2 id="chart-heading">Auslastung</h2>
        <div class="mode-tabs" aria-label="Zeitraum wählen">
            <button class:active={mode === 'Heute'} aria-pressed={mode === 'Heute'} onclick={goToday}>Heute</button>
            <button class:active={mode === 'Prognose'} aria-pressed={mode === 'Prognose'} onclick={() => selectDate(addStudioDays(studioDateString(), 1))}>Prognose</button>
            <button class:active={mode === 'Archiv'} aria-pressed={mode === 'Archiv'} onclick={() => datePicker?.selectLatestArchive()}>Archiv</button>
        </div>
    </div>
    <div class="chart-toolbar">
        <DatePicker bind:this={datePicker} {selectedDate} onSelectDate={selectDate} onGoToToday={goToday} />
        <div class="chart-legend" aria-label="Diagrammlegende">
            <span><i class="actual"></i>Messwerte</span>
            <span class:inactive={!hasForecast}><i class="forecast"></i>Prognose</span>
            <span class:inactive={!hasInterval}><i class="band"></i>80-%-Band</span>
        </div>
    </div>
    <span class="sr-only" aria-live="polite">{formattedDate}{loading ? ' – wird aktualisiert' : ''}</span>
    {#if predictions?.isHoliday && predictions.holidayName}<p class="holiday">{predictions.holidayName}</p>{/if}
    <div class="chart-container">
        <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role (The canvas is a chart image; its pointer selection is also available in the labelled select and accessible table below.) -->
        <canvas bind:this={chartCanvas} role="img" aria-label={`Auslastung am ${formattedDate}: Messwerte und Prognose. Alle Werte sind unter Details als Tabelle verfügbar.`}></canvas>
        {#if (loading && !data) || error || selectedIsEmpty}
            <div class="chart-overlay" aria-live="polite">
                {#if loading && !data}<div class="spinner"></div><p>Wird geladen …</p>
                {:else if error}<p>Tagesverlauf nicht verfügbar.</p><button class="btn btn-ghost" onclick={() => fetchData(selectedDate)}>Erneut versuchen</button>
                {:else}<p>{predictions?.status === 'training' ? 'Prognose wird vorbereitet.' : mode === 'Prognose' ? 'Noch keine Prognose verfügbar.' : 'Noch keine Messungen für diesen Tag.'}</p>{/if}
            </div>
        {/if}
    </div>
    {#if predictionMessage && !loading && !error && !selectedIsEmpty}<p class="prediction-notice" role="status">{predictionMessage}</p>{/if}
    <details class="chart-details" bind:open={showDetails}>
        <summary>Details</summary>
        <div class="detail-controls">
            <label for="chart-slot">Zeitfenster</label>
            <select id="chart-slot" bind:value={selectedSlotIndex} disabled={loading || error}>
                <option value={null}>Zeit auswählen</option>
                {#each slots as slot, index}<option value={index}>{slot.label} Uhr</option>{/each}
            </select>
        </div>
        {#if selectedSlot && !error}
            <div class="slot-detail" aria-live="polite">
                <strong>{formattedDate} · {selectedSlot.label} Uhr</strong>
                <dl>{#each details(selectedSlot) as line}<div><dt>{line.includes(': ') ? line.split(': ')[0] : 'Messzeit'}</dt><dd>{line.includes(': ') ? line.split(': ').slice(1).join(': ') : line}</dd></div>{/each}</dl>
            </div>
        {/if}
        <p class="chart-notes">15-Minuten-Zeitfenster · Uhrzeit in Coburg. Lücken bedeuten fehlende Messungen.{hasInterval ? ' Das 80-%-Band zeigt die erwartete Streuung der Prognose.' : ''}</p>
        {#if hasForecast && predictions?.issuedAt}<p class="forecast-meta">Prognose erstellt: {new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(predictions.issuedAt))} Uhr</p>{/if}
        <details class="data-table">
            <summary>Alle Werte als Tabelle</summary>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (The labelled overflow region needs keyboard focus so its full table can be scrolled without a pointer.) -->
            <div class="table-scroll" tabindex="0" role="region" aria-label="Tabelle mit Tageswerten">
                <table>
                    <caption>{formattedDate} · Auslastung in Prozent</caption>
                    <thead><tr><th scope="col">Zeit</th><th scope="col">Messwert</th><th scope="col">Prognose</th><th scope="col">80-%-Band</th><th scope="col">Abweichung</th><th scope="col">Gemessen</th></tr></thead>
                    <tbody>{#each slots as slot}<tr><th scope="row">{slot.label}</th><td>{percent(slot.actual)}</td><td>{percent(slot.prediction)}</td><td>{slot.lower !== null && slot.upper !== null ? `${percent(slot.lower)} – ${percent(slot.upper)}` : '–'}</td><td>{difference(slot) ?? '–'}</td><td>{slot.timestamp ? formatTime(slot.timestamp) : '–'}</td></tr>{/each}</tbody>
                </table>
            </div>
        </details>
    </details>
</section>

<style>
    .chart-card { position: relative; }
    .chart-header, .chart-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    h2 { font-size: 1rem; font-weight: 600; }
    .mode-tabs { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--border-color); border-radius: 7px; background: #101218; }
    .mode-tabs button { border: 0; color: var(--text-secondary); background: transparent; border-radius: 4px; padding: 5px 12px; font-size: .74rem; min-height: 29px; }
    .mode-tabs button:hover { color: var(--text-primary); background: #272b35; }
    .mode-tabs button.active { background: #353b49; color: #f4f5f8; font-weight: 600; }
    .chart-toolbar { margin: 12px 0 10px; }
    .chart-legend { display: flex; gap: 14px; align-items: center; font-size: .66rem; color: #b6bdc9; }
    .chart-legend span { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .chart-legend i { display: inline-block; width: 13px; height: 9px; }
    .chart-legend .actual { background: repeating-linear-gradient(to right, #b6bdc9, #b6bdc9 3px, transparent 3px, transparent 5px); }
    .chart-legend .forecast { height: 0; width: 18px; border-top: 2px dashed #b6bdc9; }
    .chart-legend .band { background: #a4acbe1a; border: 1px solid #a4acbe50; border-radius: 2px; }
    .chart-legend .inactive { opacity: .45; }
    .holiday { font-size: .7rem; color: var(--warning); margin: 0 0 7px; }
    .chart-container { position: relative; height: 290px; }
    .chart-overlay { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; position: absolute; inset: 0; background: #161920ef; text-align: center; padding: 15px; }
    .chart-overlay p { font-size: .78rem; color: var(--text-secondary); }
    .prediction-notice { font-size: .68rem; color: var(--text-secondary); margin: 5px 0; }
    .chart-details { margin-top: 4px; font-size: .72rem; color: var(--text-secondary); }
    summary { width: fit-content; padding: 4px 0; cursor: pointer; }
    .detail-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); margin-top: 8px; }
    .detail-controls label { color: var(--text-primary); font-size: .75rem; }
    .detail-controls select { min-width: 135px; }
    .slot-detail { margin-top: 12px; padding: 12px; background: #20242e; border: 1px solid var(--border-color); border-radius: 7px; font-size: .75rem; color: var(--text-primary); }
    .slot-detail strong { font-size: .77rem; }
    .slot-detail dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 12px 0 0; }
    .slot-detail dt { color: var(--text-secondary); font-size: .67rem; } .slot-detail dd { margin: 3px 0 0; }
    .chart-notes, .forecast-meta { color: var(--text-secondary); font-size: .66rem; margin-top: 12px; }
    .data-table { margin-top: 10px; font-size: .72rem; }
    .table-scroll { position: relative; max-height: 300px; overflow: auto; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; white-space: nowrap; text-align: left; font-variant-numeric: tabular-nums; }
    caption { text-align: left; padding: 8px; color: var(--text-primary); }
    th, td { border-bottom: 1px solid var(--border-color); padding: 8px; font-weight: 400; }
    thead th { color: var(--text-primary); background: var(--bg-secondary); position: sticky; top: 0; }
    @media (max-width: 700px) {
        .chart-header { gap: 8px; } h2 { font-size: .91rem; }
        .mode-tabs button { padding: 5px 9px; font-size: .7rem; min-height: 28px; }
        .chart-toolbar { flex-direction: column; align-items: stretch; gap: 9px; margin: 10px 0 7px; }
        .chart-legend { gap: 16px; font-size: .63rem; }
        .chart-container { height: 222px; margin-left: -5px; margin-right: -3px; }
        .chart-details { font-size: .67rem; }
        .slot-detail dl { grid-template-columns: repeat(2, 1fr); }
    }
</style>
