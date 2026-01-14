import { json, type RequestEvent } from '@sveltejs/kit';

// Simple password - in production use env variable
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'aifitness2026';

export const POST = async ({ request, cookies }: RequestEvent) => {
    try {
        const { password } = await request.json();

        if (password === ADMIN_PASSWORD) {
            // Set HTTP-only cookie for 7 days
            cookies.set('auth_session', 'valid', {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 60 * 60 * 24 * 7 // 7 days
            });

            return json({ success: true });
        }

        return json({ success: false, error: 'Falsches Passwort' }, { status: 401 });
    } catch {
        return json({ success: false, error: 'Ungültige Anfrage' }, { status: 400 });
    }
};
