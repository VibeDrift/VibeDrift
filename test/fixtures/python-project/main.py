import os
import json
import requests

DATABASE_URL = os.environ.get("DATABASE_URL")
SECRET_KEY = os.environ.get("SECRET_KEY")

# TODO: refactor this
# FIXME: broken pagination

def get_users(page=0, filters=[]):
    """Get users with mutable default arg bug"""
    response = requests.get(f"{DATABASE_URL}/users?page={page}")
    return response.json()

def process_data(data):
    try:
        return json.loads(data)
    except:
        return None

def fetch_users(page=0):
    """Duplicate of get_users"""
    response = requests.get(f"{DATABASE_URL}/users?page={page}")
    return response.json()

def handle(request):
    """Generic unclear name"""
    pass

def process(items):
    """Another generic name"""
    pass

def unused_function():
    """Nobody calls this"""
    return 42

def another_unused():
    """Also unused"""
    return 99
