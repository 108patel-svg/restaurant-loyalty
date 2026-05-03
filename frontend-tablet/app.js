const App = (() => {
    let cachedSettings = null;
    let adminPin = localStorage.getItem('admin_session_pin') || '1234';

    function setPin(pin) {
        adminPin = pin;
        localStorage.setItem('admin_session_pin', pin);
    }

    function getPin() {
        return adminPin;
    }

    async function fetchSettings() {
        const res = await fetch('/api/admin/settings', {
            headers: { 'x-admin-pin': getPin() }
        });
        if (!res.ok) throw new Error('Failed to fetch settings');
        cachedSettings = await res.json();
        return cachedSettings;
    }

    function getCachedSettings() {
        return cachedSettings;
    }

    async function saveSettingsData(settings) {
        const res = await fetch('/api/admin/settings', {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-pin': getPin() 
            },
            body: JSON.stringify({
                restaurantName: settings.restaurant_name,
                restaurantEmail: settings.restaurant_email,
                restaurantAddress: settings.restaurant_address,
                bronze: settings.bronze_threshold,
                silver: settings.silver_threshold,
                gold: settings.gold_threshold,
                vip: settings.vip_threshold,
                dNew: settings.discount_new,
                dBronze: settings.discount_bronze,
                dSilver: settings.discount_silver,
                dGold: settings.discount_gold,
                dVip: settings.discount_vip,
                adminPin: settings.admin_pin
            })
        });
        if (!res.ok) throw new Error('Failed to save settings');
        if (settings.admin_pin) setPin(settings.admin_pin);
        return await res.json();
    }

    async function getAllCustomers(searchString = '') {
        const res = await fetch(`/api/admin/customers?search=${encodeURIComponent(searchString)}`, {
            headers: { 'x-admin-pin': getPin() }
        });
        if (!res.ok) throw new Error('Failed to fetch customers');
        return await res.json();
    }

    async function getAdminStats() {
        const res = await fetch('/api/admin/stats', {
            headers: { 'x-admin-pin': getPin() }
        });
        if (!res.ok) throw new Error('Failed to fetch stats');
        return await res.json();
    }

    async function deleteCustomer(email) {
        const res = await fetch(`/api/admin/customers/${encodeURIComponent(email)}`, {
            method: 'DELETE',
            headers: { 'x-admin-pin': getPin() }
        });
        if (!res.ok) throw new Error('Failed to delete customer');
        return await res.json();
    }

    async function exportCSV() {
        const res = await fetch('/api/admin/export', {
            headers: { 'x-admin-pin': getPin() }
        });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `loyalty_export_${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
    }

    function tierLabel(tier) {
        const labels = { 'none': 'No tier', 'bronze': 'Bronze', 'silver': 'Silver', 'gold': 'Gold', 'vip': 'VIP' };
        return labels[tier] || 'Unknown';
    }

    function setAlert(containerId, message, type = 'error') {
        const container = document.getElementById(containerId);
        if (!container) return;
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.innerText = message;
        container.innerHTML = '';
        container.appendChild(alert);
        if (type === 'success') {
            setTimeout(() => { alert.remove(); }, 3000);
        }
    }

    return {
        setPin,
        getPin,
        fetchSettings,
        getCachedSettings,
        saveSettingsData,
        getAdminStats,
        getAllCustomers,
        exportCSV,
        tierLabel,
        setAlert,
        deleteCustomer
    };
})();
