<script lang="ts">
    import { analytics } from "$lib/utils/analytics";

    let importing = $state(false);
    let exporting = $state(false);
    let message = $state<{ type: "success" | "error"; text: string } | null>(
        null,
    );
    let fileInput: HTMLInputElement;

    async function handleExport() {
        try {
            exporting = true;
            message = null;

            const response = await fetch("/api/export");
            if (!response.ok) throw new Error("Export failed");

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `gym-tracker-export-${new Date().toISOString().split("T")[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            analytics.exportData();
            message = { type: "success", text: "Export erfolgreich!" };
        } catch (e) {
            message = { type: "error", text: "Export fehlgeschlagen" };
        } finally {
            exporting = false;
        }
    }

    async function handleImport() {
        const file = fileInput?.files?.[0];
        if (!file) {
            message = { type: "error", text: "Bitte wähle eine Datei aus" };
            return;
        }

        try {
            importing = true;
            message = null;

            const text = await file.text();
            const data = JSON.parse(text);

            const response = await fetch("/api/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || "Import failed");
            }

            analytics.importData(result.imported);
            message = {
                type: "success",
                text: `Import erfolgreich: ${result.imported} Einträge importiert, ${result.skipped} übersprungen`,
            };

            // Reset file input
            if (fileInput) fileInput.value = "";
        } catch (e) {
            message = {
                type: "error",
                text: e instanceof Error ? e.message : "Import fehlgeschlagen",
            };
        } finally {
            importing = false;
        }
    }

    function triggerFileSelect() {
        fileInput?.click();
    }
</script>

<div class="data-tools">
    <h3>📦 Daten Import/Export</h3>

    <div class="tools-row">
        <button
            class="btn btn-primary"
            onclick={handleExport}
            disabled={exporting}
        >
            {#if exporting}
                <span class="spinner-small"></span>
            {:else}
                ⬇️
            {/if}
            Export
        </button>

        <input
            type="file"
            accept=".json"
            bind:this={fileInput}
            onchange={handleImport}
            style="display: none;"
        />

        <button
            class="btn btn-secondary"
            onclick={triggerFileSelect}
            disabled={importing}
        >
            {#if importing}
                <span class="spinner-small"></span>
            {:else}
                ⬆️
            {/if}
            Import
        </button>
    </div>

    {#if message}
        <div class="message {message.type}">
            {message.text}
        </div>
    {/if}
</div>

<style>
    .data-tools {
        background: var(--card-bg, rgba(30, 30, 50, 0.8));
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
        border-radius: 12px;
        padding: 1.25rem;
        margin-bottom: 1rem;
    }

    h3 {
        margin: 0 0 1rem 0;
        font-size: 1rem;
        font-weight: 500;
        color: var(--text-primary, #fff);
    }

    .tools-row {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.6rem 1.2rem;
        border-radius: 8px;
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: all 0.2s ease;
    }

    .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .btn-primary {
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        color: white;
    }

    .btn-primary:hover:not(:disabled) {
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        transform: translateY(-1px);
    }

    .btn-secondary {
        background: linear-gradient(135deg, #6366f1, #4f46e5);
        color: white;
    }

    .btn-secondary:hover:not(:disabled) {
        background: linear-gradient(135deg, #4f46e5, #4338ca);
        transform: translateY(-1px);
    }

    .spinner-small {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .message {
        margin-top: 1rem;
        padding: 0.75rem 1rem;
        border-radius: 8px;
        font-size: 0.875rem;
    }

    .message.success {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        border: 1px solid rgba(34, 197, 94, 0.3);
    }

    .message.error {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
        border: 1px solid rgba(239, 68, 68, 0.3);
    }
</style>
