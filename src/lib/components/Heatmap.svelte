<script lang="ts">
    import { onMount } from "svelte";

    interface HourData {
        hour: number;
        avgPercentage: number | null;
        maxPercentage: number | null;
        minPercentage: number | null;
        dataPoints: number;
    }

    interface WeekdayData {
        weekday: number;
        weekdayName: string;
        hours: HourData[];
    }

    interface HeatmapData {
        weeks: number;
        startDate: string;
        endDate: string;
        data: WeekdayData[];
    }

    let {
        weeks = 4,
        refreshTrigger = null,
    }: { weeks?: number; refreshTrigger?: Date | null } = $props();

    let data = $state<HeatmapData | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let hoveredCell = $state<{ weekday: number; hour: number } | null>(null);

    // Gym hours: 6-22
    const gymHours = Array.from({ length: 16 }, (_, i) => i + 6);

    // Weekdays in German order (Monday first)
    const weekdayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon=1, Tue=2, ..., Sun=0
    const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

    async function fetchData() {
        try {
            loading = true;
            error = null;
            const response = await fetch(`/api/heatmap?weeks=${weeks}`);
            if (!response.ok) throw new Error("Failed to fetch");
            data = await response.json();
        } catch (e) {
            error = e instanceof Error ? e.message : "Unknown error";
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        fetchData();
    });

    $effect(() => {
        weeks; // Dependency
        fetchData();
    });

    $effect(() => {
        if (refreshTrigger) {
            fetchData();
        }
    });

    function getHourData(weekday: number, hour: number): HourData | null {
        if (!data) return null;
        const weekdayData = data.data.find((w) => w.weekday === weekday);
        if (!weekdayData) return null;
        return weekdayData.hours.find((h) => h.hour === hour) ?? null;
    }

    function getCellColor(percentage: number | null): string {
        if (percentage === null) return "var(--bg-tertiary)";

        // Green (low) to Yellow (medium) to Red (high)
        if (percentage <= 25) {
            const intensity = percentage / 25;
            return `rgba(34, 197, 94, ${0.3 + intensity * 0.5})`;
        } else if (percentage <= 50) {
            const intensity = (percentage - 25) / 25;
            // Transition from green to yellow
            const r = Math.round(34 + (234 - 34) * intensity);
            const g = Math.round(197 + (179 - 197) * intensity);
            const b = Math.round(94 + (8 - 94) * intensity);
            return `rgba(${r}, ${g}, ${b}, 0.7)`;
        } else if (percentage <= 75) {
            const intensity = (percentage - 50) / 25;
            // Transition from yellow to red
            const r = Math.round(234 + (239 - 234) * intensity);
            const g = Math.round(179 + (68 - 179) * intensity);
            const b = Math.round(8 + (68 - 8) * intensity);
            return `rgba(${r}, ${g}, ${b}, 0.8)`;
        } else {
            return `rgba(239, 68, 68, ${0.7 + (percentage - 75) / 100})`;
        }
    }

    function getTextColor(percentage: number | null): string {
        if (percentage === null) return "var(--text-secondary)";
        if (percentage > 40) return "white";
        return "var(--text-primary)";
    }

    function formatTooltip(hourData: HourData | null): string {
        if (!hourData || hourData.avgPercentage === null) return "Keine Daten";
        return `Ø ${hourData.avgPercentage}% (${hourData.minPercentage}-${hourData.maxPercentage}%)`;
    }

    function isCurrentCell(weekday: number, hour: number): boolean {
        const now = new Date();
        return now.getDay() === weekday && now.getHours() === hour;
    }
</script>

<div class="heatmap-wrapper">
    {#if loading && !data}
        <div class="loading">
            <div class="spinner"></div>
        </div>
    {:else if error}
        <div class="error">
            <p>Fehler beim Laden</p>
            <button class="btn btn-ghost" onclick={fetchData}
                >Erneut versuchen</button
            >
        </div>
    {:else if data}
        <div class="heatmap-scroll">
            <div class="heatmap">
                <!-- Header row with hours -->
                <div class="heatmap-row header-row">
                    <div class="weekday-label"></div>
                    {#each gymHours as hour}
                        <div class="hour-label">{hour}</div>
                    {/each}
                </div>

                <!-- Data rows -->
                {#each weekdayOrder as weekday, i}
                    <div class="heatmap-row">
                        <div class="weekday-label">{weekdayLabels[i]}</div>
                        {#each gymHours as hour}
                            {@const hourData = getHourData(weekday, hour)}
                            <div
                                class="heatmap-cell"
                                class:no-data={hourData?.avgPercentage === null}
                                class:current-cell={isCurrentCell(
                                    weekday,
                                    hour,
                                )}
                                style="background: {getCellColor(
                                    hourData?.avgPercentage ?? null,
                                )}; color: {getTextColor(
                                    hourData?.avgPercentage ?? null,
                                )}"
                                title={formatTooltip(hourData)}
                                onmouseenter={() =>
                                    (hoveredCell = { weekday, hour })}
                                onmouseleave={() => (hoveredCell = null)}
                            >
                                {#if hourData?.avgPercentage !== null}
                                    {Math.round(hourData?.avgPercentage ?? 0)}
                                {:else}
                                    -
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/each}
            </div>
        </div>

        <!-- Legend -->
        <div class="legend">
            <span class="legend-label">Niedrig</span>
            <div class="legend-gradient"></div>
            <span class="legend-label">Hoch</span>
            <span class="legend-info">
                {data.weeks === 1
                    ? "Letzte Woche"
                    : `Letzte ${data.weeks} Wochen`}
            </span>
        </div>

        <!-- Tooltip for hovered cell -->
        {#if hoveredCell}
            {@const hourData = getHourData(
                hoveredCell.weekday,
                hoveredCell.hour,
            )}
            {#if hourData && hourData.avgPercentage !== null}
                <div class="detail-panel">
                    <strong
                        >{weekdayLabels[
                            weekdayOrder.indexOf(hoveredCell.weekday)
                        ]}
                        {hoveredCell.hour}:00 - {hoveredCell.hour +
                            1}:00</strong
                    >
                    <div class="detail-stats">
                        <div class="stat">
                            <span class="stat-label">Durchschnitt</span>
                            <span class="stat-value"
                                >{hourData.avgPercentage}%</span
                            >
                        </div>
                        <div class="stat">
                            <span class="stat-label">Min / Max</span>
                            <span class="stat-value"
                                >{hourData.minPercentage}% - {hourData.maxPercentage}%</span
                            >
                        </div>
                        <div class="stat">
                            <span class="stat-label">Messungen</span>
                            <span class="stat-value">{hourData.dataPoints}</span
                            >
                        </div>
                    </div>
                </div>
            {/if}
        {/if}
    {/if}
</div>

<style>
    .heatmap-wrapper {
        position: relative;
        min-height: 200px;
    }

    .loading,
    .error {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1rem;
    }

    .error p {
        color: var(--text-secondary);
    }

    .heatmap-scroll {
        overflow-x: auto;
        padding-bottom: 0.5rem;
    }

    .heatmap {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 700px;
    }

    .heatmap-row {
        display: flex;
        gap: 4px;
        align-items: center;
    }

    .header-row {
        margin-bottom: 4px;
    }

    .weekday-label {
        width: 32px;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary);
        text-align: center;
        flex-shrink: 0;
    }

    .hour-label {
        flex: 1;
        min-width: 36px;
        text-align: center;
        font-size: 0.7rem;
        color: var(--text-secondary);
    }

    .heatmap-cell {
        flex: 1;
        min-width: 36px;
        position: relative;
    }

    .heatmap-cell.current-cell {
        box-shadow:
            0 0 0 2px var(--accent-primary),
            0 0 10px rgba(99, 102, 241, 0.5);
    }

    .legend {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 1rem;
        font-size: 0.75rem;
        color: var(--text-secondary);
    }

    .legend-gradient {
        width: 120px;
        height: 12px;
        border-radius: 6px;
        background: linear-gradient(
            to right,
            rgba(34, 197, 94, 0.6),
            rgba(234, 179, 8, 0.7),
            rgba(239, 68, 68, 0.8)
        );
    }

    .legend-info {
        margin-left: auto;
        opacity: 0.7;
    }

    .detail-panel {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        padding: 0.75rem;
        box-shadow: var(--shadow-lg);
        z-index: 100;
        min-width: 180px;
        margin-bottom: 0.5rem;
    }

    .detail-panel strong {
        display: block;
        margin-bottom: 0.5rem;
        font-size: 0.875rem;
    }

    .detail-stats {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .stat {
        display: flex;
        justify-content: space-between;
        font-size: 0.75rem;
    }

    .stat-label {
        color: var(--text-secondary);
    }

    .stat-value {
        font-weight: 600;
    }
</style>
