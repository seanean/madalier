CREATE TABLE shipment_product (
    shipment_product_uuid STRING NOT NULL,
    shipment_uuid STRING NOT NULL,
    product_id STRING NOT NULL,
    product_qty INT NOT NULL,
    meta_source_event_names STRING NOT NULL,
    meta_source_event_id_lst STRING NOT NULL,
    meta_source_file_path_lst STRING NOT NULL,
    meta_insert_timestamp TIMESTAMP NOT NULL,
    meta_updated_timestamp TIMESTAMP
);
