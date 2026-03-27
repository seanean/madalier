from flask import Flask, render_template
from app_logger import get_logger
import json
import jsonschema


# init logging
logger = get_logger(__name__)

# init app
app = Flask(__name__)

@app.route('/')
def index():
    # return render_template('index.html')
    return load_json()


def load_json():
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

if __name__ == '__main__':
    app.run(debug=True, port=54321, host='localhost')