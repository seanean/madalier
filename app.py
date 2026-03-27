from flask import Flask, render_template, request, jsonify
from app_logger import get_logger
import json
import jsonschema
import os


# init logging
logger = get_logger(__name__)

# init app
app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/load_model')
def api_load_model():
    return load_model()

def load_model():
    with open('schemas/model.json') as f:
        schema = json.load(f)
        logger.info('Model loaded.')
    with open('data/models/test_model.json') as f:
        data = json.load(f)
        logger.info('Model schema loaded.')
    try:
        jsonschema.validate(instance=data, schema=schema)
        logger.info('Model schema validation success.')
    except jsonschema.ValidationError as e:
        logger.error('Model schema validation failed with ValidationError: %s', e)
    except Exception as e:
        logger.error('Model schema validation failed with exception: %s', e)
    return data


@app.route('/api/load_layout')
def api_load_layout():
    return load_layout()

def load_layout():
    with open('schemas/layout.json') as f:
        schema = json.load(f)
        logger.info('Layout schema loaded.')
    with open('data/models/test_layout.json') as f:
        data = json.load(f)
        logger.info('Layout loaded.')
    try:
        jsonschema.validate(instance=data, schema=schema)
        logger.info('Layout schema validation success.')
    except jsonschema.ValidationError as e:
        logger.error('Layout schema validation failed with ValidationError: %s', e)
    except Exception as e:
        logger.error('Layout schema validation failed with exception: %s', e)
    return data


@app.route('/api/save_layout', methods=['POST'])
def api_save_layout():
    layout_to_save = request.get_json()
    return save_layout(layout_to_save)

def save_layout(layout_to_save):
    with open('schemas/layout.json') as f:
        schema = json.load(f)
        logger.info('Layout schema loaded.')
    try:
        jsonschema.validate(instance=layout_to_save, schema=schema)
        logger.info('Layout schema validation success.')
        try:
            file_path = os.path.join('data/models', 'test_layout.json')
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(layout_to_save, f, indent=4, ensure_ascii=False)
            return jsonify({
                'success': True,
                'message': f'Layout saved successfully to {file_path}'
            }), 200
        except Exception as e:
            logger.error('Layout save failed with exception: %s', e)
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500
    except jsonschema.ValidationError as e:
        logger.error('Layout schema validation failed with ValidationError: %s', e)
        return jsonify({
                'success': False,
                'error': str(e)
            }), 500
    except Exception as e:
        logger.error('Layout schema validation failed with exception: %s', e)
        return jsonify({
                'success': False,
                'error': str(e)
            }), 500

if __name__ == '__main__':
    app.run(debug=True, port=54321, host='localhost')