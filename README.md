# Restaurant Loyalty Programme

Dual-site architecture for in-restaurant and customer-facing loyalty management.

## 🏗️ Architecture

The app is split into two completely separate deployments:

### Site 1: Restaurant Tablet (Internal)
**URL**: `http://localhost:3000/tablet/`
Used physically in the restaurant on a tablet at the till.
- **Check-in**: Customers enter Name and Email (Required).
- **Cashier Dashboard**: Staff record spend for pending check-ins (`/tablet/cashier.html`).
- **Admin Dashboard**: Staff manage settings and export data (`/tablet/admin.html`).

### Site 2: Customer Rewards Portal (Public)
**URL**: `http://localhost:3000/public/`
Customers scan a QR code to check their own status on their phones.
- **Status Check**: Customers enter their email to see their current tier, spend, and discounts.
- **Unsubscribe**: Manage email preferences.

## 🔐 Security

- **reCAPTCHA v3**: Invisible protection on all forms to prevent bot submissions.
- **PIN Authentication**: Staff pages are protected by a 4-digit PIN (Default: `1234`).
- **GDPR Compliance**: Subprocessor disclosure included in terms, with easy unsubscribe options.

## 🚀 Getting Started

1. Install dependencies: `npm install`
2. Set up your `.env` file (see `.env.example`).
3. Run migrations: `node backend/migrate.js`
4. Start the server: `npm start`
