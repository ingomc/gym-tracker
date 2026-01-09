<script lang="ts">
    import { onMount } from "svelte";

    interface WeatherData {
        temperature: number;
        precipitation: number;
        cloudCover: number;
        isRaining: boolean;
    }

    interface CurrentData {
        percentage: number | null;
        level: string | null;
        lastUpdated: string | null;
        weather: WeatherData | null;
        message?: string;
    }

    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();

    let data = $state<CurrentData | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let showWeatherPopover = $state(false);

    async function fetchData() {
        try {
            loading = true;
            error = null;
            const response = await fetch("/api/current");
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
        // Auto-refresh every 30 seconds
        const interval = setInterval(fetchData, 30000);
        return () => clearInterval(interval);
    });

    $effect(() => {
        if (refreshTrigger) {
            fetchData();
        }
    });

    function getLevelClass(level: string | null): string {
        if (!level) return "";
        return `level-${level.toLowerCase()}`;
    }

    function formatTime(isoString: string | null): string {
        if (!isoString) return "-";
        return new Date(isoString).toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    function getProgressColor(percentage: number): string {
        if (percentage <= 30) return "var(--success)";
        if (percentage <= 60) return "var(--warning)";
        return "var(--danger)";
    }

    function getWeatherIcon(weather: WeatherData): string {
        if (weather.isRaining) return "🌧️";
        if (weather.cloudCover > 70) return "☁️";
        if (weather.cloudCover > 30) return "⛅";
        return "☀️";
    }

    function toggleWeatherPopover() {
        showWeatherPopover = !showWeatherPopover;
    }
</script>

<div class="card current-card">
    <div class="card-header">
        <span class="card-title">Aktuell</span>
        <div class="header-right">
            {#if data?.weather}
                <button
                    class="weather-btn"
                    onclick={toggleWeatherPopover}
                    title="Wetter anzeigen"
                >
                    {getWeatherIcon(data.weather)}
                </button>
                {#if showWeatherPopover}
                    <div class="weather-popover">
                        <div class="popover-header">
                            <span>Aktuelles Wetter</span>
                            <button
                                class="close-btn"
                                onclick={() => (showWeatherPopover = false)}
                                >×</button
                            >
                        </div>
                        <div class="weather-details">
                            <div class="weather-row">
                                <span class="weather-icon">🌡️</span>
                                <span class="weather-label">Temperatur</span>
                                <span class="weather-value"
                                    >{data.weather.temperature.toFixed(
                                        1,
                                    )}°C</span
                                >
                            </div>
                            <div class="weather-row">
                                <span class="weather-icon">💧</span>
                                <span class="weather-label">Niederschlag</span>
                                <span class="weather-value"
                                    >{data.weather.precipitation.toFixed(1)} mm</span
                                >
                            </div>
                            <div class="weather-row">
                                <span class="weather-icon">☁️</span>
                                <span class="weather-label">Bewölkung</span>
                                <span class="weather-value"
                                    >{data.weather.cloudCover}%</span
                                >
                            </div>
                            <div class="weather-row">
                                <span class="weather-icon">🌧️</span>
                                <span class="weather-label">Regen</span>
                                <span class="weather-value"
                                    >{data.weather.isRaining
                                        ? "Ja"
                                        : "Nein"}</span
                                >
                            </div>
                        </div>
                        <div class="popover-footer">
                            Daten von Open-Meteo (Coburg)
                        </div>
                    </div>
                {/if}
            {/if}
            <span class="live-indicator pulse">● LIVE</span>
        </div>
    </div>

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
    {:else if data?.percentage === null}
        <div class="no-data">
            <p>Noch keine Daten</p>
            <span class="hint">Warte auf erste Messung...</span>
        </div>
    {:else if data}
        <div class="percentage-display">
            <span class="percentage-value">{data.percentage}</span>
            <span class="percentage-sign">%</span>
        </div>

        <div class="progress-bar">
            <div
                class="progress-fill"
                style="width: {data.percentage}%; background: {getProgressColor(
                    data.percentage,
                )}"
            ></div>
        </div>

        <div class="level-row">
            <span class="level-badge {getLevelClass(data.level)}">
                {#if data.level === "LOW"}
                    🟢 Niedrig
                {:else if data.level === "MEDIUM"}
                    🟡 Mittel
                {:else if data.level === "HIGH"}
                    🔴 Hoch
                {:else}
                    {data.level}
                {/if}
            </span>
        </div>

        <div class="last-update">
            Letzte Messung: {formatTime(data.lastUpdated)}
        </div>
    {/if}
</div>

<style>
    .current-card {
        text-align: center;
    }

    .header-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        position: relative;
    }

    .weather-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 0.5rem;
        padding: 0.25rem 0.5rem;
        font-size: 1rem;
        cursor: pointer;
        transition: all 0.2s;
    }

    .weather-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.25);
    }

    .weather-popover {
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        background: var(--card-bg, #1a1a2e);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 0.75rem;
        padding: 0;
        min-width: 220px;
        z-index: 100;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
        text-align: left;
    }

    .popover-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        font-weight: 500;
        font-size: 0.875rem;
    }

    .close-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        font-size: 1.25rem;
        cursor: pointer;
        padding: 0;
        line-height: 1;
    }

    .close-btn:hover {
        color: var(--text-primary);
    }

    .weather-details {
        padding: 0.75rem 1rem;
    }

    .weather-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0;
    }

    .weather-icon {
        font-size: 0.875rem;
        width: 1.25rem;
    }

    .weather-label {
        flex: 1;
        font-size: 0.8rem;
        color: var(--text-secondary);
    }

    .weather-value {
        font-size: 0.8rem;
        font-weight: 500;
    }

    .popover-footer {
        padding: 0.5rem 1rem;
        font-size: 0.65rem;
        color: var(--text-secondary);
        opacity: 0.6;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
    }

    .live-indicator {
        color: var(--success);
        font-size: 0.75rem;
        font-weight: 600;
    }

    .loading,
    .error,
    .no-data {
        padding: 2rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
    }

    .error p,
    .no-data p {
        color: var(--text-secondary);
    }

    .hint {
        font-size: 0.75rem;
        color: var(--text-secondary);
        opacity: 0.7;
    }

    .percentage-display {
        display: flex;
        align-items: baseline;
        justify-content: center;
        margin: 1rem 0;
    }

    .percentage-value {
        font-size: 4rem;
        font-weight: 700;
        line-height: 1;
        background: linear-gradient(
            135deg,
            var(--accent-primary),
            var(--accent-secondary)
        );
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }

    .percentage-sign {
        font-size: 1.5rem;
        font-weight: 600;
        color: var(--text-secondary);
        margin-left: 0.25rem;
    }

    .progress-bar {
        height: 8px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        overflow: hidden;
        margin: 1rem 0;
    }

    .progress-fill {
        height: 100%;
        border-radius: 4px;
        transition:
            width 0.5s ease,
            background 0.3s ease;
    }

    .level-row {
        margin: 1rem 0;
    }

    .last-update {
        font-size: 0.75rem;
        color: var(--text-secondary);
        margin-top: 1rem;
    }
</style>
