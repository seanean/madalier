CREATE TABLE [shipment_status] (
    [shipment_status_uuid] NVARCHAR(MAX) NOT NULL REFERENCES [shipment] ([shipment_uuid]),
    [shipment_uuid] NVARCHAR(MAX) NOT NULL,
    [shipment_status] NVARCHAR(MAX) NOT NULL,
    [shipment_status_tmst] DATETIMEOFFSET NOT NULL,
    [meta_source_event_names] NVARCHAR(MAX) NOT NULL,
    [meta_source_event_id_lst] NVARCHAR(MAX) NOT NULL,
    [meta_source_file_path_lst] NVARCHAR(MAX) NOT NULL,
    [meta_insert_timestamp] DATETIMEOFFSET NOT NULL,
    [meta_updated_timestamp] DATETIMEOFFSET,
    PRIMARY KEY ([shipment_status_uuid])
);
