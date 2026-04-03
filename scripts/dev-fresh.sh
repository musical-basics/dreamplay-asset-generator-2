#!/bin/bash
# Fresh dev start — clears Next.js build cache then starts dev server
# Run this after pulling new changes to avoid stale bundle errors

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🧹 Clearing .next cache..."
rm -rf "$PROJECT_DIR/.next"

echo "🚀 Starting dev server..."
cd "$PROJECT_DIR" && pnpm dev
