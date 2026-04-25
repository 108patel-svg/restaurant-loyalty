const App = (() => {
    const STORAGE_KEY = 'loyalty_data';
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

    function saveSettingsData(settings) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function getData() {
        const d = localStorage.getItem(STORAGE_KEY);
        return d ? JSON.parse(d) : {};
    }

    function saveData(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    function tierOrder(tier) {
        const order = { 'none': 0, 'bronze': 1, 'silver': 2, 'gold': 3, 'vip': 4 };
        return order[tier] || 0;
    }

    function getTier(spend90d, settings) {
        if (spend90d >= settings.vip_threshold) return 'vip';
        if (spend90d >= settings.gold_threshold) return 'gold';
        if (spend90d >= settings.silver_threshold) return 'silver';
        if (spend90d >= settings.bronze_threshold) return 'bronze';
        return 'none';
    }

    function tierLabel(tier) {
        const labels = { 'none': 'No tier', 'bronze': 'Bronze', 'silver': 'Silver', 'gold': 'Gold', 'vip': 'VIP' };
        return labels[tier] || 'Unknown';
    }

    function tierDiscount(tier, settings, isNew) {
        if (isNew) return settings.discount_new;
        if (tier === 'vip') return settings.discount_vip;
        if (tier === 'gold') return settings.discount_gold;
        if (tier === 'silver') return settings.discount_silver;
        if (tier === 'bronze') return settings.discount_bronze;
        return 0;
    }

    function spend90d(visits) {
        const now = Date.now();
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
        const threshold = now - ninetyDaysMs;
        return visits
            .filter(v => v.ts >= threshold)
            .reduce((sum, v) => sum + Number(v.spend), 0);
    }

    function sendTierUpEmail(customer, newTier, discount) {
        // In Phase 2: replace with fetch() POST to backend.
        console.log(`[EMAIL STUB] To: ${customer.email} | Subject: You've reached ${tierLabel(newTier)} status! | Discount: ${discount}%`);
    }

    function submitVisit(name, email, spendStr) {
        // Phase 1: LocalStorage
        // Phase 2: fetch('/api/visit', { method: 'POST', body: JSON.stringify({ name, email, spend }) })
        return new Promise((resolve) => {
            const data = getData();
            const settings = getSettings();
            const emailKey = email.toLowerCase();
            const spend = parseFloat(spendStr);
            let isNew = false;

            if (!data[emailKey]) {
                isNew = true;
                data[emailKey] = {
                    name: name,
                    email: emailKey,
                    visits: [],
                    firstVisit: Date.now(),
                    currentTier: 'none'
                };
            } else {
                data[emailKey].name = name;
            }

            const customer = data[emailKey];
            const prevTier = customer.currentTier;

            const newVisit = {
                ts: Date.now(),
                spend: spend,
                date: new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' }).format(new Date())
            };

            customer.visits.push(newVisit);

            const currentSpend90d = spend90d(customer.visits);
            const tier = getTier(currentSpend90d, settings);

            let tierUp = false;
            if (tierOrder(tier) > tierOrder(prevTier)) {
                tierUp = true;
            }

            customer.currentTier = tier;
            saveData(data);

            const discount = tierDiscount(tier, settings, isNew);

            if (tierUp && !isNew) {
                sendTierUpEmail(customer, tier, discount);
            }

            let nextTier = 'none';
            let nextThreshold = 0;
            if (tier === 'none') { nextTier = 'bronze'; nextThreshold = settings.bronze_threshold; }
            else if (tier === 'bronze') { nextTier = 'silver'; nextThreshold = settings.silver_threshold; }
            else if (tier === 'silver') { nextTier = 'gold'; nextThreshold = settings.gold_threshold; }
            else if (tier === 'gold') { nextTier = 'vip'; nextThreshold = settings.vip_threshold; }

            resolve({
                success: true,
                isNew,
                tierUp,
                prevTier,
                tier,
                spend90d: currentSpend90d,
                discount,
                nextTier,
                nextThreshold,
                totalVisits: customer.visits.length,
                firstVisit: customer.firstVisit
            });
        });
    }

    function getAllCustomers(searchString = '') {
        const data = getData();
        const result = [];

        for (const key in data) {
            const c = data[key];
            const s90d = spend90d(c.visits);

            if (searchString) {
                const q = searchString.toLowerCase();
                if (!c.name.toLowerCase().includes(q) && !c.email.toLowerCase().includes(q)) continue;
            }

            const lastVisitTs = c.visits.length > 0 ? c.visits[c.visits.length - 1].ts : 0;

            result.push({
                id: key,
                name: c.name,
                email: c.email,
                current_tier: c.currentTier,
                created_at: c.firstVisit,
                visit_count: c.visits.length,
                spend_90d: s90d,
                last_visit_ts: lastVisitTs
            });
        }

        result.sort((a, b) => b.last_visit_ts - a.last_visit_ts);
        return result;
    }

    function getAdminStats() {
        const data = getData();
        let totalCustomers = 0;
        let visitedToday = 0;
        let active90d = 0;
        let revenue90d = 0;

        const tierCounts = { none: 0, bronze: 0, silver: 0, gold: 0, vip: 0 };
        let allVisits = [];

        const now = Date.now();
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

        const isToday = (ts) => {
            const d1 = new Date(ts);
            const d2 = new Date();
            return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
        };

        for (const key in data) {
            const c = data[key];
            totalCustomers++;
            tierCounts[c.currentTier]++;

            let hasActive90d = false;

            c.visits.forEach(v => {
                allVisits.push({
                    customerName: c.name,
                    ts: v.ts,
                    date: v.date,
                    tier: c.currentTier,
                    spend: v.spend
                });

                if (isToday(v.ts)) {
                    visitedToday++;
                }
                if (now - v.ts <= ninetyDaysMs) {
                    hasActive90d = true;
                    revenue90d += Number(v.spend);
                }
            });

            if (hasActive90d) active90d++;
        }

        allVisits.sort((a, b) => b.ts - a.ts);

        return {
            totalCustomers,
            visitedToday,
            active90d,
            revenue90d,
            tierCounts,
            recentVisits: allVisits.slice(0, 20)
        };
    }

    function checkAdminPin(pin) {
        const s = getSettings();
        return pin === s.admin_pin;
    }

    function exportCSV() {
        const customers = getAllCustomers();
        let csv = "Name,Email,Tier,Visits,90-Day Spend (£),Member Since\n";
        customers.forEach(c => {
            const dateStr = new Intl.DateTimeFormat('en-GB').format(new Date(c.created_at));
            const name = `"${c.name.replace(/"/g, '""')}"`;
            csv += `${name},${c.email},${tierLabel(c.current_tier)},${c.visit_count},${c.spend_90d.toFixed(2)},${dateStr}\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", "customers_export.csv");
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function showView(id) {
        document.querySelectorAll('.view').forEach(el => el.style.display = 'none');
        const el = document.getElementById(id);
        if (el) el.style.display = 'block';
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

    function resetForm(formId) {
        const f = document.getElementById(formId);
        if (f) f.reset();
    }

    return {
        getSettings,
        saveSettingsData,
        submitVisit,
        getAdminStats,
        getAllCustomers,
        exportCSV,
        checkAdminPin,
        tierOrder,
        tierDiscount,
        tierLabel,
        getTier,
        spend90d,
        showView,
        setAlert,
        resetForm
    };
})();
