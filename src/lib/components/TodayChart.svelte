<script lang="ts">
    import { onMount } from "svelte";
    import { Chart, registerables } from "chart.js";

    Chart.register(...registerables);

    interface HourData {
        hour: number;
        percentage: number | null;
        level: string | null;
        dataPoints: number;
    }

    interface TodayData {
        date: string;
        hourlyData: HourData[];
    }

    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();

    let data = $state<TodayData | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let chartCanvas = $state<HTMLCanvasElement | null>(null);
    let chart: Chart | null = null;

    async function fetchData() {
        try {
            loading = true;
            error = null;
            const response = await fetch("/api/today");
            if (!response.ok) throw new Error("Failed to fetch");
            data = await response.json();
            updateChart();
        } catch (e) {
            error = e instanceof Error ? e.message : "Unknown error";
        } finally {
            loading = false;
        }
    }

    function updateChart() {
        if (!chartCanvas || !data) return;

        // Filter to gym hours (6-22)
        const gymHours = data.hourlyData.filter(
            (h) => h.hour >= 6 && h.hour < 22,
        );
        const labels = gymHours.map(
            (h) => `${h.hour.toString().padStart(2, "0")}:00`,
        );
        const values = gymHours.map((h) => h.percentage ?? 0);
        const currentHour = new Date().getHours();

        const colors = gymHours.map((h) => {
            if (h.percentage === null) return "rgba(100, 100, 120, 0.3)";
            if (h.hour === currentHour) return "rgba(99, 102, 241, 1)";
            if (h.percentage <= 30) return "rgba(34, 197, 94, 0.8)";
            if (h.percentage <= 60) return "rgba(234, 179, 8, 0.8)";
            return "rgba(239, 68, 68, 0.8)";
        });

        if (chart) {
            chart.data.labels = labels;
            chart.data.datasets[0].data = values;
            chart.data.datasets[0].backgroundColor = colors;
            chart.update();
        } else {
            chart = new Chart(chartCanvas, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Auslastung %",
                            data: values,
                            backgroundColor: colors,
                            borderRadius: 6,
                            borderSkipped: false,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false,
                        },
                        tooltip: {
                            backgroundColor: "rgba(26, 26, 46, 0.95)",
                            titleColor: "#fff",
                            bodyColor: "#a0a0b0",
                            borderColor: "rgba(255, 255, 255, 0.1)",
                            borderWidth: 1,
                            padding: 12,
                            cornerRadius: 8,
                            callbacks: {
                                label: (context) => {
                                    const value = context.parsed.y;
                                    const hourData =
                                        gymHours[context.dataIndex];
                                    return [
                                        `Auslastung: ${value}%`,
                                        `Datenpunkte: ${hourData.dataPoints}`,
                                    ];
                                },
                            },
                        },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            grid: {
                                color: "rgba(255, 255, 255, 0.05)",
                            },
                            ticks: {
                                color: "#a0a0b0",
                                callback: (value) => `${value}%`,
                            },
                        },
                        x: {
                            grid: {
                                display: false,
                            },
                            ticks: {
                                color: "#a0a0b0",
                            },
                        },
                    },
                },
            });
        }
    }

    onMount(() => {
        fetchData();
        const interval = setInterval(fetchData, 60000);
        return () => {
            clearInterval(interval);
            if (chart) chart.destroy();
        };
    });

    $effect(() => {
        if (refreshTrigger) {
            fetchData();
        }
    });

    $effect(() => {
        if (chartCanvas && data) {
            updateChart();
        }
    });
</script>

<div class="card">
    <div class="card-header">
        <span class="card-title">📈 Heute</span>
        {#if data}
            <span class="date-label"
                >{new Date(data.date).toLocaleDateString("de-DE", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                })}</span
            >
        {/if}
    </div>

    <div class="chart-container">
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
        {:else}
            <canvas bind:this={chartCanvas}></canvas>
        {/if}
    </div>
</div>

<style>
    .chart-container {
        height: 280px;
        position: relative;
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

    .date-label {
        font-size: 0.875rem;
        color: var(--text-secondary);
    }

    canvas {
        width: 100% !important;
        height: 100% !important;
    }
</style>
