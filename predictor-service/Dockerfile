FROM python:3.11-slim

WORKDIR /app

# Install build dependencies for Prophet
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py .

# Create data directory mount point
RUN mkdir -p /app/data

ENV PYTHONUNBUFFERED=1
ENV DATABASE_PATH=/app/data/gym.db

EXPOSE 5000

# Use gunicorn for production
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--timeout", "120", "app:app"]
