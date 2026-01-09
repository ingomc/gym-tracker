"""
Gym Utilization Prediction Service using Facebook Prophet.
Provides ML-based predictions for gym utilization patterns.
"""

import os
import sqlite3
from datetime import datetime, timedelta
from flask import Flask, jsonify, request
import pandas as pd
from prophet import Prophet
import holidays

app = Flask(__name__)

# Configuration
DATABASE_PATH = os.environ.get('DATABASE_PATH', '/app/data/gym.db')
BUNDESLAND = 'BY'  # Bayern for AI-Fitness

# Cache for trained model
model_cache = {
    'model': None,
    'last_trained': None,
    'retrain_interval': timedelta(hours=24)
}


def get_db_connection():
    """Create a read-only connection to the SQLite database."""
    conn = sqlite3.connect(f'file:{DATABASE_PATH}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_training_data():
    """Load historical utilization data from SQLite."""
    try:
        conn = get_db_connection()
        query = """
            SELECT timestamp, hour, percentage 
            FROM utilization_readings 
            ORDER BY timestamp ASC
        """
        df = pd.read_sql_query(query, conn)
        conn.close()
        
        if df.empty:
            return None
            
        # Convert timestamp to datetime
        df['ds'] = pd.to_datetime(df['timestamp'], unit='s')
        df['y'] = df['percentage']
        
        return df[['ds', 'y']]
    except Exception as e:
        print(f"Error loading training data: {e}")
        return None


def train_model():
    """Train Prophet model on historical data."""
    print("[Predictor] Loading training data...")
    df = load_training_data()
    
    if df is None or len(df) < 50:
        print(f"[Predictor] Not enough data for training ({len(df) if df is not None else 0} samples)")
        return None
    
    print(f"[Predictor] Training model with {len(df)} samples...")
    
    # Create and configure Prophet model
    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=True,
        daily_seasonality=True,
        changepoint_prior_scale=0.05
    )
    
    # Add German holidays for NRW
    de_holidays = holidays.Germany(prov=BUNDESLAND)
    model.add_country_holidays(country_name='DE')
    
    # Fit the model
    model.fit(df)
    
    model_cache['model'] = model
    model_cache['last_trained'] = datetime.now()
    
    print("[Predictor] Model training complete!")
    return model


def needs_retraining():
    """Check if model needs to be retrained."""
    if model_cache['model'] is None or model_cache['last_trained'] is None:
        return True
    
    elapsed = datetime.now() - model_cache['last_trained']
    return elapsed >= model_cache['retrain_interval']


def get_holiday_info(date):
    """Get holiday information for a date in NRW."""
    de_holidays = holidays.Germany(prov=BUNDESLAND, years=date.year)
    
    if date in de_holidays:
        return True, de_holidays.get(date)
    return False, None


def generate_predictions(target_date):
    """Generate predictions for all 15-min slots on a given date."""
    # Ensure model is trained
    if needs_retraining():
        train_model()
    
    model = model_cache['model']
    if model is None:
        return None
    
    # Create future dataframe for the target date (6:00 to 22:00)
    predictions = []
    start_hour = 6
    end_hour = 22
    
    future_times = []
    for hour in range(start_hour, end_hour):
        for minute in [0, 15, 30, 45]:
            dt = datetime(target_date.year, target_date.month, target_date.day, hour, minute)
            future_times.append(dt)
    
    future_df = pd.DataFrame({'ds': future_times})
    
    # Generate predictions
    forecast = model.predict(future_df)
    
    for _, row in forecast.iterrows():
        dt = row['ds']
        percentage = max(0, min(100, round(row['yhat'])))
        predictions.append({
            'hour': dt.hour,
            'minute': dt.minute,
            'percentage': percentage
        })
    
    return predictions


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'healthy',
        'model_trained': model_cache['model'] is not None,
        'last_trained': model_cache['last_trained'].isoformat() if model_cache['last_trained'] else None
    })


@app.route('/predict', methods=['GET'])
def predict():
    """Prediction endpoint."""
    date_param = request.args.get('date')
    
    if date_param:
        try:
            target_date = datetime.strptime(date_param, '%Y-%m-%d').date()
        except ValueError:
            return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD'}), 400
    else:
        target_date = datetime.now().date()
    
    # Get holiday info
    is_holiday, holiday_name = get_holiday_info(target_date)
    
    # Generate predictions
    predictions = generate_predictions(target_date)
    
    if predictions is None:
        return jsonify({
            'error': 'Model not ready',
            'date': str(target_date),
            'weekday': target_date.weekday(),
            'isHoliday': is_holiday,
            'holidayName': holiday_name,
            'predictions': []
        }), 503
    
    return jsonify({
        'date': str(target_date),
        'weekday': target_date.weekday(),
        'isHoliday': is_holiday,
        'holidayName': holiday_name,
        'predictions': predictions
    })


@app.route('/train', methods=['POST'])
def trigger_train():
    """Manually trigger model retraining."""
    model = train_model()
    if model:
        return jsonify({'status': 'success', 'message': 'Model trained successfully'})
    return jsonify({'status': 'error', 'message': 'Training failed - not enough data'}), 500


if __name__ == '__main__':
    # Train model on startup
    print("[Predictor] Starting prediction service...")
    train_model()
    
    # Run Flask app
    app.run(host='0.0.0.0', port=5000, debug=False)
