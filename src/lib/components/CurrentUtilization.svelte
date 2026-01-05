<script lang="ts">
    import { onMount } from "svelte";

    interface CurrentData {
        percentage: number | null;
        level: string | null;
        lastUpdated: string | null;
        message?: string;
    }

    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();

    let data = $state<CurrentData | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);

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
</script>

<div class="card current-card">
    <div class="card-header">
        <span class="card-title">Aktuell</span>
        <span class="live-indicator pulse">● LIVE</span>
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
