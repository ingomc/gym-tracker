<script lang="ts">
    import { onMount } from "svelte";
    import { Chart, registerables } from "chart.js";
    import DatePicker from "./DatePicker.svelte";

    Chart.register(...registerables);

    interface Reading {
        time: string;
        timestamp: string;
        hour: number;
        minute: number;
        percentage: number;
        level: string;
    }

    interface TodayRawData {
        date: string;
        dateFormatted: string;
        isToday: boolean;
        readings: Reading[];
        count: number;
    }

    interface Prediction {
        hour: number;
        minute: number;
        percentage: number;
    }

    interface PredictionData {
        date: string;
        weekday: number;
        isHoliday: boolean;
        holidayName: string | null;
        predictions: Prediction[];
    }

    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();

    let data = $state<TodayRawData | null>(null);
    let predictions = $state<PredictionData | null>(null);
    let selectedDate = $state<string | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let chartCanvas = $state<HTMLCanvasElement | null>(null);
    let chart: Chart | null = null;
    let datePicker: DatePicker;

    async function fetchPredictions(date?: string) {
        try {
            const url = date
                ? `/api/predictions?date=${date}`
                : "/api/predictions";
            const response = await fetch(url);
            if (response.ok) {
                predictions = await response.json();
            } else {
                predictions = null;
            }
        } catch {
            predictions = null;
        }
    }

    async function fetchData(date?: string) {
        try {
            loading = true;
            error = null;
            const url = date ? `/api/today-raw?date=${date}` : "/api/today-raw";
            const response = await fetch(url);
            if (!response.ok) throw new Error("Failed to fetch");
            data = await response.json();
            if (data) selectedDate = data.date;

            // Fetch predictions for today and future dates
            const selectedDateObj = new Date(data.date + "T00:00:00");
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const maxFutureDate = new Date(today);
            maxFutureDate.setDate(maxFutureDate.getDate() + 7);

            if (selectedDateObj >= today && selectedDateObj <= maxFutureDate) {
                await fetchPredictions(data.date);
            } else {
                predictions = null;
            }

            updateChart();
        } catch (e) {
            error = e instanceof Error ? e.message : "Unknown error";
        } finally {
            loading = false;
        }
    }

    function handleSelectDate(date: string) {
        fetchData(date);
    }

    function handleGoToToday() {
        selectedDate = null;
        fetchData();
    }

    function updateChart() {
        if (!chartCanvas || !data) return;

        const INTERVAL = 15;
        const bucketedData = new Map<number, Reading>();
        for (const r of data.readings) {
            const slotIndex = Math.floor((r.hour * 60 + r.minute) / INTERVAL);
            bucketedData.set(slotIndex, r);
        }

        // Create prediction lookup map
        const predictionMap = new Map<string, number>();
        if (predictions?.predictions) {
            for (const p of predictions.predictions) {
                const key = `${p.hour}:${p.minute}`;
                predictionMap.set(key, p.percentage);
            }
        }

        const allSlots: {
            label: string;
            value: number | null;
            prediction: number | null;
            color: string;
        }[] = [];
        // Only show slots from 6:00 to 22:00 (typical gym hours)
        const START_SLOT = 24; // 6:00 (6 * 4)
        const END_SLOT = 88; // 22:00 (22 * 4)
        for (let i = START_SLOT; i < END_SLOT; i++) {
            const h = Math.floor((i * INTERVAL) / 60);
            const m = (i * INTERVAL) % 60;
            const timeStr = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
            const reading = bucketedData.get(i);
            const predictionValue = predictionMap.get(`${h}:${m}`) ?? null;

            if (reading) {
                let color = "rgba(239, 68, 68, 0.8)";
                if (reading.percentage <= 30) color = "rgba(34, 197, 94, 0.8)";
                else if (reading.percentage <= 60)
                    color = "rgba(234, 179, 8, 0.8)";
                allSlots.push({
                    label: timeStr,
                    value: reading.percentage,
                    prediction: predictionValue,
                    color,
                });
            } else {
                allSlots.push({
                    label: timeStr,
                    value: null,
                    prediction: predictionValue,
                    color: "transparent",
                });
            }
        }

        const labels = allSlots.map((m) => m.label);
        const values = allSlots.map((m) => m.value);
        const predictionValues = allSlots.map((m) => m.prediction);
        const colors = allSlots.map((m) => m.color);

        // Build datasets array
        const datasets: any[] = [];

        // Add prediction dataset first (background layer) - for today and future dates
        if (predictions?.predictions?.length) {
            datasets.push({
                label: "Vorhersage %",
                data: predictionValues,
                backgroundColor: "rgba(100, 149, 237, 0.25)",
                borderRadius: 1,
                borderSkipped: false,
                barPercentage: 0.9,
                categoryPercentage: 0.9,
                order: 1, // Render behind actual data
            });
        }

        // Add actual data dataset (foreground layer)
        datasets.push({
            label: "Auslastung %",
            data: values,
            backgroundColor: colors,
            borderRadius: 1,
            borderSkipped: false,
            barPercentage: 0.7,
            categoryPercentage: 0.8,
            order: 0, // Render in front
        });

        if (chart) {
            chart.data.labels = labels;
            chart.data.datasets = datasets;
            chart.update();
        } else {
            chart = new Chart(chartCanvas, {
                type: "bar",
                data: {
                    labels,
                    datasets,
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: "rgba(26, 26, 46, 0.95)",
                            titleColor: "#fff",
                            bodyColor: "#a0a0b0",
                            borderColor: "rgba(255, 255, 255, 0.1)",
                            borderWidth: 1,
                            padding: 12,
                            cornerRadius: 8,
                            filter: (item) => item.parsed.y !== null,
                            callbacks: {
                                title: (items) => items[0]?.label || "",
                                label: (context) => {
                                    if (context.parsed.y === null) return "";
                                    const slotIndex = context.dataIndex;
                                    const slot = allSlots[slotIndex];
                                    const reading = bucketedData.get(
                                        slotIndex + START_SLOT,
                                    );
                                    const lines: string[] = [];

                                    // Show actual reading if available
                                    if (
                                        context.dataset.label ===
                                            "Auslastung %" &&
                                        slot?.value !== null
                                    ) {
                                        lines.push(
                                            `Auslastung: ${slot.value}%`,
                                        );
                                        if (reading)
                                            lines.push(
                                                `Level: ${reading.level}`,
                                            );
                                    }

                                    // Show prediction if available
                                    if (
                                        context.dataset.label ===
                                            "Vorhersage %" &&
                                        slot?.prediction !== null
                                    ) {
                                        lines.push(
                                            `Vorhersage: ${slot.prediction}%`,
                                        );
                                    }

                                    // Show holiday info
                                    if (
                                        predictions?.isHoliday &&
                                        predictions.holidayName
                                    ) {
                                        lines.push(
                                            `Feiertag: ${predictions.holidayName}`,
                                        );
                                    }

                                    return lines;
                                },
                            },
                        },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            grid: { color: "rgba(255, 255, 255, 0.05)" },
                            ticks: {
                                color: "#a0a0b0",
                                callback: (value) => `${value}%`,
                            },
                        },
                        x: {
                            grid: { display: false },
                            ticks: {
                                color: "#a0a0b0",
                                maxRotation: 0,
                                autoSkip: true,
                                maxTicksLimit: 17,
                                callback: function (value, index) {
                                    // Show label every hour (every 4 slots), starting from 6:00
                                    if (index % 4 === 0) {
                                        const hour = Math.floor(index / 4) + 6;
                                        return `${hour.toString().padStart(2, "0")}:00`;
                                    }
                                    return "";
                                },
                            },
                        },
                    },
                },
            });
        }
    }

    onMount(() => {
        fetchData();
        const interval = setInterval(
            () => fetchData(selectedDate || undefined),
            60000,
        );
        return () => {
            clearInterval(interval);
            if (chart) chart.destroy();
        };
    });

    let lastRefreshTrigger: Date | null = null;
    $effect(() => {
        if (refreshTrigger && refreshTrigger !== lastRefreshTrigger) {
            lastRefreshTrigger = refreshTrigger;
            fetchData(selectedDate || undefined);
            datePicker?.refresh();
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
        <span class="card-title"
            >{data?.isToday ? "📈 Heute" : "📅 Archiv"}</span
        >
        <DatePicker
            bind:this={datePicker}
            {selectedDate}
            onSelectDate={handleSelectDate}
            onGoToToday={handleGoToToday}
        />
    </div>

    <div class="chart-container">
        {#if loading && !data}
            <div class="loading">
                <div class="spinner"></div>
            </div>
        {:else if error}
            <div class="error">
                <p>Fehler beim Laden</p>
                <button
                    class="btn btn-ghost"
                    onclick={() => fetchData(selectedDate || undefined)}
                >
                    Erneut versuchen
                </button>
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

    canvas {
        width: 100% !important;
        height: 100% !important;
    }
</style>
