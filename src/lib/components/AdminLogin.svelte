<script lang="ts">
    import { isAuthenticated, login, logout } from "$lib/stores/auth";
    import { analytics } from "$lib/utils/analytics";

    let showLoginModal = $state(false);
    let password = $state("");
    let error = $state("");
    let loading = $state(false);

    async function handleLogin(e: Event) {
        e.preventDefault();
        error = "";
        loading = true;

        const result = await login(password);

        if (result.success) {
            analytics.login();
            showLoginModal = false;
            password = "";
        } else {
            error = result.error || "Login fehlgeschlagen";
        }

        loading = false;
    }

    async function handleLogout() {
        analytics.logout();
        await logout();
    }

    function openModal() {
        showLoginModal = true;
        error = "";
        password = "";
    }

    function closeModal() {
        showLoginModal = false;
        error = "";
        password = "";
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") closeModal();
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="admin-area">
    {#if $isAuthenticated}
        <button
            class="admin-btn logged-in"
            onclick={handleLogout}
            title="Abmelden"
        >
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16,17 21,12 16,7" />
                <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Admin
        </button>
    {:else}
        <button class="admin-btn" onclick={openModal} title="Anmelden">
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10,17 15,12 10,7" />
                <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
            Login
        </button>
    {/if}
</div>

{#if showLoginModal}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={closeModal}>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="modal" onclick={(e) => e.stopPropagation()}>
            <button class="modal-close" onclick={closeModal}>×</button>
            <h2>🔐 Admin-Bereich</h2>
            <form onsubmit={handleLogin}>
                <input
                    type="password"
                    bind:value={password}
                    placeholder="Passwort eingeben"
                    disabled={loading}
                    autofocus
                />
                {#if error}
                    <p class="error">{error}</p>
                {/if}
                <button
                    type="submit"
                    class="login-btn"
                    disabled={loading || !password}
                >
                    {#if loading}
                        Anmelden...
                    {:else}
                        Anmelden
                    {/if}
                </button>
            </form>
        </div>
    </div>
{/if}

<style>
    .admin-area {
        display: flex;
        align-items: center;
    }

    .admin-btn {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.4rem 0.8rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: var(--text-secondary);
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .admin-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--text-primary);
    }

    .admin-btn.logged-in {
        background: rgba(34, 197, 94, 0.15);
        border-color: rgba(34, 197, 94, 0.3);
        color: #22c55e;
    }

    .admin-btn.logged-in:hover {
        background: rgba(239, 68, 68, 0.15);
        border-color: rgba(239, 68, 68, 0.3);
        color: #ef4444;
    }

    .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .modal {
        position: relative;
        background: var(--card-bg, rgba(30, 30, 50, 0.95));
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 2rem;
        width: 90%;
        max-width: 320px;
        animation: modalIn 0.2s ease-out;
    }

    @keyframes modalIn {
        from {
            opacity: 0;
            transform: scale(0.95);
        }
        to {
            opacity: 1;
            transform: scale(1);
        }
    }

    .modal-close {
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
        background: none;
        border: none;
        color: var(--text-secondary);
        font-size: 1.5rem;
        cursor: pointer;
        line-height: 1;
        padding: 0.25rem;
    }

    .modal-close:hover {
        color: var(--text-primary);
    }

    h2 {
        margin: 0 0 1.5rem 0;
        font-size: 1.25rem;
        text-align: center;
    }

    form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    input {
        padding: 0.75rem 1rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        color: var(--text-primary);
        font-size: 1rem;
    }

    input:focus {
        outline: none;
        border-color: var(--accent-color, #6366f1);
    }

    input::placeholder {
        color: var(--text-secondary);
    }

    .error {
        margin: 0;
        padding: 0.5rem 0.75rem;
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 6px;
        color: #ef4444;
        font-size: 0.875rem;
        text-align: center;
    }

    .login-btn {
        padding: 0.75rem 1rem;
        background: linear-gradient(135deg, #6366f1, #4f46e5);
        border: none;
        border-radius: 8px;
        color: white;
        font-size: 1rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .login-btn:hover:not(:disabled) {
        background: linear-gradient(135deg, #4f46e5, #4338ca);
        transform: translateY(-1px);
    }

    .login-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
</style>
