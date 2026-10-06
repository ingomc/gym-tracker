<script lang="ts">
    import { onMount } from 'svelte';
    import { getUtilizationColorRGBA, getUtilizationTextColor } from '$lib/utils/colors';
    import { studioParts } from '$lib/utils/studio-time';
    interface HourData { hour: number; avgPercentage: number | null; maxPercentage: number | null; minPercentage: number | null; dataPoints: number; observedDays?: number; }
    interface HeatmapData { weeks: number; startDate: string; endDate: string; data: { weekday: number; weekdayName: string; hours: HourData[] }[]; }
    let { weeks = 4, refreshTrigger = null }: { weeks?: number; refreshTrigger?: Date | null } = $props();
    let data = $state<HeatmapData | null>(null);
    let loading = $state(true);
    let failed = $state(false);
    let selected = $state<{ weekday: number; hour: number } | null>(null);
    let pinned = $state(false);
    let position = $state({ left: 0, top: 0, below: false, arrowLeft: 0 });
    let now = $state(studioParts());
    let wrapper = $state<HTMLDivElement>();
    let popover = $state<HTMLDivElement>();
    let anchor: HTMLButtonElement | null = null;
    let controller: AbortController | null = null;
    let sequence = 0;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressFocus = false;
    const gymHours = Array.from({ length: 16 }, (_, index) => index + 6);
    const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
    const weekdayLabels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const selectedData = $derived(selected ? getHourData(selected.weekday, selected.hour) : null);
    function getHourData(weekday: number, hour: number): HourData | null { return data?.data.find((day) => day.weekday === weekday)?.hours.find((entry) => entry.hour === hour) ?? null; }
    function number(value: number | null | undefined) { return value == null ? '–' : Number(value.toFixed(1)).toLocaleString('de-DE'); }
    function label(weekday: number, hour: number, cell: HourData | null) {
        return `${weekdayNames[weekday]}, ${hour} bis ${hour + 1} Uhr: ${cell?.avgPercentage == null ? 'keine Messungen' : `durchschnittlich ${number(cell.avgPercentage)} Prozent, ${cell.dataPoints} Messungen an ${cell.observedDays ?? 'unbekannt vielen'} Tagen`}`;
    }
    async function fetchData(targetWeeks: number) {
        const request = ++sequence;
        controller?.abort();
        const active = new AbortController(); controller = active;
        loading = true; failed = false; selected = null; pinned = false;
        try {
            const response = await fetch(`/api/heatmap?weeks=${targetWeeks}`, { signal: active.signal });
            if (!response.ok) throw new Error('heatmap');
            const result = await response.json();
            if (request === sequence && !active.signal.aborted) { data = result; now = studioParts(); }
        } catch { if (request === sequence && !active.signal.aborted) failed = true; }
        finally { if (request === sequence) loading = false; }
    }
    function placeDetails() {
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const height = popover?.offsetHeight ?? 32;
        const width = popover?.offsetWidth ?? 170;
        const center = rect.left + rect.width / 2;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, center - width / 2));
        const below = rect.top - height - 8 < 8;
        position = {
            left, below,
            top: Math.max(8, Math.min(window.innerHeight - height - 8, below ? rect.bottom + 8 : rect.top - height - 8)),
            arrowLeft: Math.max(10, Math.min(width - 10, center - left)),
        };
    }
    function showDetails(event: Event, weekday: number, hour: number, pin = false) {
        if (suppressFocus || (pinned && !pin)) return;
        clearTimeout(hideTimer);
        if (pin && pinned && selected?.weekday === weekday && selected?.hour === hour) { closeDetails(); return; }
        anchor = event.currentTarget as HTMLButtonElement;
        selected = { weekday, hour }; pinned = pin; placeDetails();
    }
    function hideDetails() { if (!pinned) hideTimer = setTimeout(() => { if (!pinned) selected = null; }, 180); }
    function closeDetails(restoreFocus = false) {
        clearTimeout(hideTimer); selected = null; pinned = false;
        if (restoreFocus) { suppressFocus = true; anchor?.focus({ preventScroll: true }); requestAnimationFrame(() => { suppressFocus = false; }); }
    }
    function key(event: KeyboardEvent, row: number, column: number) {
        let targetRow = row, targetColumn = column;
        if (event.key === 'ArrowLeft') targetColumn--;
        else if (event.key === 'ArrowRight') targetColumn++;
        else if (event.key === 'ArrowUp') targetRow--;
        else if (event.key === 'ArrowDown') targetRow++;
        else if (event.key === 'Home') targetColumn = 0;
        else if (event.key === 'End') targetColumn = 15;
        else return;
        event.preventDefault(); pinned = false;
        wrapper?.querySelector<HTMLButtonElement>(`[data-row="${Math.max(0, Math.min(6, targetRow))}"][data-column="${Math.max(0, Math.min(15, targetColumn))}"]`)?.focus();
    }
    $effect(() => { const targetWeeks = weeks; refreshTrigger; void fetchData(targetWeeks); });
    $effect(() => { if (selected && popover) placeDetails(); });
    onMount(() => {
        const handleScroll = () => { if (selected) placeDetails(); };
        window.addEventListener('scroll', handleScroll, true);
        return () => { ++sequence; controller?.abort(); clearTimeout(hideTimer); window.removeEventListener('scroll', handleScroll, true); };
    });
</script>

<svelte:window onresize={placeDetails} onkeydown={(event) => { if (event.key === 'Escape' && selected) { event.preventDefault(); closeDetails(true); } }} onpointerdown={(event) => { if (selected && !wrapper?.contains(event.target as Node) && !popover?.contains(event.target as Node)) closeDetails(); }} />

<div class="heatmap-wrapper" bind:this={wrapper} aria-busy={loading}>
    {#if loading && !data}<div class="empty-state"><div class="spinner"></div><p>Wochenübersicht wird geladen</p></div>
    {:else if failed}<div class="empty-state"><p>Die Wochenübersicht konnte nicht geladen werden.</p><button class="btn btn-ghost" onclick={() => fetchData(weeks)}>Erneut versuchen</button></div>
    {:else if data}
        <p class="sr-only" id="heatmap-keyboard-help">Feld auswählen für Details. Mit Pfeiltasten navigieren, mit Escape schließen.</p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (The labelled horizontal overflow region must accept focus for keyboard scrolling independently of its cell buttons.) -->
        <div class="heatmap-scroll" role="region" aria-label="Auslastung nach Wochentag und Stunde, horizontal scrollbar" aria-describedby="heatmap-keyboard-help" tabindex="0">
            <table class="heatmap">
                <caption class="sr-only">Durchschnittliche Auslastung in Prozent, letzte {data.weeks} Wochen</caption>
                <thead><tr><th scope="col"><span class="sr-only">Tag</span></th>{#each gymHours as hour}<th scope="col">{String(hour).padStart(2, '0')}<span class="sr-only"> Uhr</span></th>{/each}</tr></thead>
                <tbody>
                    {#each weekdayOrder as weekday, row}
                        <tr><th scope="row">{weekdayLabels[row]}</th>
                            {#each gymHours as hour, column}
                                {@const cell = getHourData(weekday, hour)}
                                {@const isSelected = selected?.weekday === weekday && selected.hour === hour}
                                <td><button class="heatmap-cell" class:no-data={cell?.avgPercentage == null} class:current={now.weekday === weekday && now.hour === hour} class:selected={isSelected}
                                    style={`background: ${getUtilizationColorRGBA(cell?.avgPercentage ?? null)}; color: ${getUtilizationTextColor(cell?.avgPercentage ?? null)}`}
                                    disabled={loading} data-row={row} data-column={column} aria-label={label(weekday, hour, cell)} aria-pressed={pinned && isSelected} aria-describedby={isSelected ? 'heatmap-detail' : undefined}
                                    onpointerenter={(event) => { if (event.pointerType === 'mouse') showDetails(event, weekday, hour); }} onpointerleave={hideDetails}
                                    onfocus={(event) => showDetails(event, weekday, hour)} onblur={() => { if (!pinned) hideDetails(); }}
                                    onclick={(event) => showDetails(event, weekday, hour, true)} onkeydown={(event) => key(event, row, column)}>{cell?.avgPercentage == null ? '–' : Math.round(cell.avgPercentage)}</button></td>
                            {/each}
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
        <div class="legend" aria-label="Farbskala der durchschnittlichen Auslastung"><span>0 %</span><div class="legend-gradient"></div><span>50 %+</span></div>
        {#if selected}
            <div class="detail-panel" class:below={position.below} id="heatmap-detail" role="tooltip" bind:this={popover} style={`left: ${position.left}px; top: ${position.top}px; --arrow-left: ${position.arrowLeft}px`} onpointerenter={() => clearTimeout(hideTimer)} onpointerleave={hideDetails}>
                <span>{weekdayNames[selected.weekday].slice(0, 2)} · {String(selected.hour).padStart(2, '0')}–{String(selected.hour + 1).padStart(2, '0')} Uhr</span>
                <strong>{selectedData?.avgPercentage == null ? 'Keine Daten' : `Ø ${number(selectedData.avgPercentage)} %`}</strong>
            </div>
        {/if}
    {/if}
</div>

<style>
    .heatmap-wrapper { position: relative; min-height: 210px; }
    .empty-state { min-height: 210px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 14px; font-size: .8rem; color: var(--text-secondary); text-align: center; }
    .heatmap-scroll { position: relative; overflow-x: auto; padding-bottom: 8px; }
    .heatmap { width: 100%; min-width: 710px; border-collapse: separate; border-spacing: 4px; table-layout: fixed; }
    th { font-size: .69rem; font-weight: 500; color: var(--text-secondary); }
    thead th { padding-bottom: 5px; } tbody th { text-align: left; } th:first-child { width: 30px; }
    td { padding: 0; }
    .heatmap-cell { width: 100%; min-height: 34px; border: 1px solid #ffffff05; border-radius: 4px; font-size: .7rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .heatmap-cell:hover, .heatmap-cell.selected { outline: 2px solid #f3f5f9; outline-offset: 1px; }
    .heatmap-cell:focus-visible { outline: 2px solid white; outline-offset: 2px; }
    .heatmap-cell.no-data { background-image: repeating-linear-gradient(135deg, transparent, transparent 5px, #ffffff05 5px, #ffffff05 6px) !important; }
    .heatmap-cell.current { box-shadow: inset 0 -3px 0 #f3f5f9; }
    .heatmap-cell:disabled { opacity: .5; }
    .legend { display: flex; align-items: center; gap: 8px; font-size: .63rem; color: var(--text-secondary); margin: 7px 0 0; }
    .legend-gradient { height: 7px; width: 100px; border-radius: 5px; background: linear-gradient(to right, rgb(34,197,94), rgb(234,179,8), rgb(239,68,68)); }
    .detail-panel { position: fixed; z-index: 100; display: flex; align-items: center; gap: 8px; width: max-content; max-width: calc(100vw - 16px); border: 1px solid #4a5160; border-radius: 5px; background: #242832; box-shadow: 0 3px 10px #0004; padding: 6px 8px; font-size: .7rem; line-height: 1.3; color: #c9ced9; white-space: nowrap; }
    .detail-panel strong { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
    .detail-panel::after { content: ''; position: absolute; left: var(--arrow-left); bottom: -6px; transform: translateX(-50%); border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 6px solid #242832; }
    .detail-panel.below::after { top: -6px; bottom: auto; border-top: 0; border-bottom: 6px solid #242832; }
    @media (max-width: 700px) {
        .heatmap { min-width: 735px; border-spacing: 4px; } .heatmap-cell { min-height: 38px; }
        .legend { font-size: .6rem; gap: 7px; } .legend-gradient { width: 85px; }
    }
</style>
