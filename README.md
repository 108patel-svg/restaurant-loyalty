# Restaurant Loyalty Programme

A full-stack loyalty rewards system for restaurants. Features include customer tier tracking (Bronze, Silver, Gold, VIP), automated email rewards via SendGrid, and an admin dashboard.

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS
- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **Email**: SendGrid

## Getting Started

### 1. Prerequisites
- Node.js installed
- A PostgreSQL database (local or hosted like Neon.tech/ElephantSQL)
- A SendGrid API Key (optional, for emails)

### 2. Setup
1. Clone the repository.
2. Go to the `backend` folder:
   ```bash
   cd backend
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```
5. Fill in your `DATABASE_URL` and `SENDGRID_API_KEY`.

### 3. Database Migration
Run the migration script to create the necessary tables:
```bash
npm run migrate
```

### 4. Running the App
Start the backend server:
```bash
npm start
```
The app will be available at `http://localhost:3000`.

## Collaboration
To collaborate, push your changes to a new branch and create a Pull Request.
