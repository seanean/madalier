import logging
import sys
from datetime import datetime

###########################Logging Setup###########################

def get_logger(name: str) -> logging.Logger:

    # init logger
    logger = logging.getLogger(name)
    logging_level = logging.DEBUG

    if not logger.handlers:
        # create fileHandler for logging to send data to file
        file_handler = logging.FileHandler(datetime.now().strftime('%Y-%m-%d_%H-%M_madalier.log'))
        file_handler.encoding = 'utf-8'
        file_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))

        # create streamHandler to send to terminal
        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))

        # add handlers to the logger
        logger.addHandler(stream_handler)
        logger.addHandler(file_handler)
        logger.setLevel(logging_level)

    return logger