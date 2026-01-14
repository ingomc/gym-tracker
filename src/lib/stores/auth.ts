import { writable } from 'svelte/store';

// Simple auth store for client-side state
export const isAuthenticated = writable<boolean>(false);

// Check if user is authenticated (called on app init)
export async function checkAuth(): Promise<boolean> {
    try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
        isAuthenticated.set(data.authenticated);
        return data.authenticated;
    } catch {
        isAuthenticated.set(false);
        return false;
    }
}

// Login function
export async function login(password: string): Promise<{ success: boolean; error?: string }> {
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            isAuthenticated.set(true);
            return { success: true };
        }

        return { success: false, error: data.error || 'Login fehlgeschlagen' };
    } catch {
        return { success: false, error: 'Verbindungsfehler' };
    }
}

// Logout function
export async function logout(): Promise<void> {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
        // Ignore errors
    }
    isAuthenticated.set(false);
}
