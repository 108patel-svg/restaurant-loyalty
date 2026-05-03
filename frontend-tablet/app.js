const App = (() => {
    const SETTINGS_KEY = 'loyalty_settings';

    const defaultSettings = {
        restaurant_name: 'The Restaurant',
        bronze_threshold: 300,
        silver_threshold: 600,
        gold_threshold: 1000,
        vip_threshold: 2000,
        discount_new: 10,
        discount_bronze: 10,
        discount_silver: 15,
        discount_gold: 20,
        discount_vip: 25,
        admin_pin: '1234'
    };

    function getSettings() {
        const s = localStorage.getItem(SETTINGS_KEY);
        return s ? JSON.parse(s) : { ...defaultSettings };
    }

    async function saveSettingsData(settings) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        await fetch('/api/admin/settings', {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-pin': settings.admin_pin 
            },
            body: JSON.stringify({
                restaurantName: settings.restaurant_name,
                bronze: settings.bronze_threshold,
                silver: settings.silver_threshold,
                gold: settings.gold_threshold,
                vip: settings.vip_threshold,
                dNew: settings.discount_new,
                dBronze: settings.discount_bronze,
                dSilver: settings.discount_silver,
                dGold: settings.discount_gold,
                dVip: settings.discount_vip
            })
        });
    }

    function tierOrder(tier) {
        const order = { 'none': 0, 'bronze': 1, 'silver': 2, 'gold': 3, 'vip': 4 };
        return order[tier] || 0;
    }

    function tierLabel(tier) {
        const labels = { 'none': 'No tier', 'bronze': 'Bronze', 'silver': 'Silver', 'gold': 'Gold', 'vip': 'VIP' };
        return labels[tier] || 'Unknown';
    }

    async function getAllCustomers(searchString = '') {
        const res = await fetch(`/api/admin/customers?search=${encodeURIComponent(searchString)}`, {
            headers: { 'x-admin-pin': getSettings().admin_pin }
        });
        if (!res.ok) throw new Error('Failed to fetch customers');
        const customers = await res.json();
        return customers.map(c => ({
            ...c,
            spend_90d: parseFloat(c.spend_90d) || 0,
            visit_count: parseInt(c.visit_count) || 0
        }));
    }

    async function getAdminStats() {
        const res = await fetch('/api/admin/stats', {
            headers: { 'x-admin-pin': getSettings().admin_pin }
        });
        if (!res.ok) throw new Error('Failed to fetch stats');
        return await res.json();
    }

    function checkAdminPin(pin) {
        const s = getSettings();
        return pin === s.admin_pin;
    }

    async function exportCSV() {
        const res = await fetch('/api/admin/export', {
            headers: { 'x-admin-pin': getSettings().admin_pin }
        });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "customers_export.csv";
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
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

    async function deleteCustomer(email) {
        const res = await fetch(`/api/admin/customers/${encodeURIComponent(email)}`, {
            method: 'DELETE',
            headers: { 'x-admin-pin': getSettings().admin_pin }
        });
        if (!res.ok) throw new Error('Failed to delete customer');
        return await res.json();
    }

    async function deleteVisit(id) {
        const res = await fetch(`/api/admin/visits/${id}`, {
            method: 'DELETE',
            headers: { 'x-admin-pin': getSettings().admin_pin }
        });
        if (!res.ok) throw new Error('Failed to delete visit');
        return await res.json();
    }

    async function editVisitSpend(id, spend) {
        const res = await fetch(`/api/admin/visits/${id}/spend`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-pin': getSettings().admin_pin 
            },
            body: JSON.stringify({ spend })
        });
        if (!res.ok) throw new Error('Failed to update spend');
        return await res.json();
    }

    function setupInactivityLogout(onLogout) {
        let inactivityTimer;
        const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
        function resetTimer() {
            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(onLogout, INACTIVITY_TIMEOUT);
        }
        ['click', 'touchstart', 'mousemove', 'keypress', 'scroll'].forEach(evt => {
            document.addEventListener(evt, resetTimer);
        });
        resetTimer();
    }

    return {
        getSettings,
        saveSettingsData,
        getAdminStats,
        getAllCustomers,
        exportCSV,
        checkAdminPin,
        tierOrder,
        tierLabel,
        setAlert,
        deleteCustomer,
        deleteVisit,
        editVisitSpend,
        setupInactivityLogout
    };
})();
