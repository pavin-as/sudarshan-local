-- Empty stand-in for the Yarago mirror, for a TEST database in a workspace without shichika's yarago_schema.json.
-- Only the tables and columns the clinical views, the analytics migrations and the server read; no rows.
--   psql -d <test db> -f server/test/yarago_stub.sql   (before db/migrations and db/views)
CREATE SCHEMA IF NOT EXISTS yarago;
CREATE TABLE IF NOT EXISTS yarago.tblpatientregistration (apatient_id int PRIMARY KEY, apatientcode text, tfisrt_name text,
  tmiddle_name text, tlast_name text, tdob date, tage numeric, tsex text, tmobile_no text, preferredlanguage text,
  vip_category_vals text, inserteddate timestamp);
CREATE TABLE IF NOT EXISTS yarago.tblappointments (aappoint_id int PRIMARY KEY, npatient_id int, tappoint_date_time timestamp,
  tokenid int, nappoint_type_id int, nstatus_id int, ndoctor_id int, treason_for_visit text, inserteddate timestamp,
  consultant_adviced_time timestamp);
CREATE TABLE IF NOT EXISTS yarago.tblappointmenttype (aappoint_type_id int PRIMARY KEY, tappoint_type text);
CREATE TABLE IF NOT EXISTS yarago.tbldoctor (adoctor_id int PRIMARY KEY, tdoctorname text);
CREATE TABLE IF NOT EXISTS yarago.tbl_patient_appointment_history (nappoint_id int, npatient_id int,
  dva_r_id text, dva_l_id text, ph_r_id text, ph_l_id text, visionvadv_r_id text, visionvadv_l_id text,
  visionvanv_r_id text, visionvanv_l_id text, oeiop_right text, oeiop_left text, final_diagnosis text,
  present_complaints text, comp_right text, comp_left text, agencompremarks text, systemic_illness text,
  agensysillremarks text, drug_allergies text, opthalamic_history text, opht_right text, opht_left text,
  opthalmic_remarks text, medicinename text, medinstruction text, advice_id text, advice_r_value text,
  advice_l_value text, remarks text, followup text, followup_indays text, followup_inmonths text,
  adilatationstatus int, examination_history text, examination_right text, examination_left text);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_complaints (row_id int, content text);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_sysillness (aillness_id int, tillness text);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_drugallergy (adrug_id int, tdrugallergy text);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_ophthalmic_history (arow_id int, tcontent text);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_advice (rowid int, content text);
CREATE TABLE IF NOT EXISTS yarago.tbloptometryexamination (aoe_id int, nappointment_id int, iop_right text, iop_left text,
  nct_right text, nct_left text, cct_right text, cct_left text);
CREATE TABLE IF NOT EXISTS yarago.tblpatientissurgery (ps_id int, nappoint_id int, issurgery int);
CREATE TABLE IF NOT EXISTS yarago.tbleyeparts_examination_child (arow_id int, texamination_for_eyepart_name text,
  nmst_mst_eyeparts_examination_id int);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_eyeparts_examination (arow_id int, teyeparts text);
CREATE TABLE IF NOT EXISTS yarago.tblpatientinjectionopdinvestigationdetials (aid int, npatid int, napptid int,
  fromnormalapptid int, dateoftreatment timestamp, apptdate timestamp, isinjectiongiven text, procedurename text,
  drugsuggested text, drugsuggestedeye text, eyetobeoperated text, followupdate timestamp, injapptremarks text,
  followupcomments text, isdeleted int);
CREATE TABLE IF NOT EXISTS yarago.tblpatientlaseropdinvestigationdetials (alaserid int, npatid int, napptid int,
  fromnormalapptid int, dateoftreatment timestamp, apptdate timestamp, adviced_procedurename_re text,
  adviced_procedurename_le text, proceduredonename_re text, proceduredonename_le text, remarks_re text, remarks_le text,
  complecations_re text, complecations_le text, isdeleted int);
CREATE TABLE IF NOT EXISTS yarago.tblfollowuppatientdetails (afollowid int, npatient_id int, current_appointment_id int,
  follow_up_date timestamp, appointment_status int, realised_appointment_id int, comments text, updated_date timestamp,
  inserted_date timestamp, isactive int);
CREATE TABLE IF NOT EXISTS yarago.tbltimerpatientwaiting (aid int, napptid int, npatid int, nmoduletimerid int,
  startdatetime timestamp, enddatetime timestamp, isdeleted int);
CREATE TABLE IF NOT EXISTS yarago.tbltimermodulewise (amoduletimerid int, modulename text);
CREATE TABLE IF NOT EXISTS yarago.tbl_patient_payment_mainduedetails (amainduerowid int, npatientid int,
  dueamttowardshospital numeric, opddueamt numeric, pharmacydueamt numeric, opticaldueamt numeric, ipddueamt numeric,
  dueamttowardspatient numeric, modifieddate timestamp, isactive int, isdeleted int);
CREATE TABLE IF NOT EXISTS yarago.tblpurchasepaymentdetails (poid int, ninvoice text, atotalinvoiceamount numeric,
  apaidamount numeric, aadjustmentamount numeric, creditnoteamt numeric, nsuppid int, isactive int,
  inserteddate timestamp, lastmodifieddate timestamp);
CREATE TABLE IF NOT EXISTS yarago.tblopticalpharmacypurchase (poid int, ainvoice text, dcdate text, orderdate text,
  nsupplierid int, isactive int, inserteddate timestamp);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_vendor (avenid int, avendorname text);
-- what the EMR completeness check reads (clinical.emr_visit_items, D-028 / D-051); added so an older test database gets them
CREATE TABLE IF NOT EXISTS yarago.tbldiagnosis (adiagnosis_id int, tappt_id int, tdiagnosis_mst_id text);
ALTER TABLE yarago.tbl_patient_appointment_history ADD COLUMN IF NOT EXISTS ucnva_r_id text,
  ADD COLUMN IF NOT EXISTS arsph_r_id text, ADD COLUMN IF NOT EXISTS nct_right text, ADD COLUMN IF NOT EXISTS nct_left text,
  ADD COLUMN IF NOT EXISTS pupil_right text, ADD COLUMN IF NOT EXISTS pupil_left text,
  ADD COLUMN IF NOT EXISTS colourvision_right text, ADD COLUMN IF NOT EXISTS colourvision_left text,
  ADD COLUMN IF NOT EXISTS familyhistory text, ADD COLUMN IF NOT EXISTS systemic_status text,
  ADD COLUMN IF NOT EXISTS diagnosis text, ADD COLUMN IF NOT EXISTS diagnosis_right text, ADD COLUMN IF NOT EXISTS diagnosis_left text,
  ADD COLUMN IF NOT EXISTS followup_inweeks text;
ALTER TABLE yarago.tbloptometryexamination ADD COLUMN IF NOT EXISTS pupil_right text, ADD COLUMN IF NOT EXISTS pupil_left text,
  ADD COLUMN IF NOT EXISTS colourvision_right text, ADD COLUMN IF NOT EXISTS colourvision_left text;
-- what the money reconciliation reads (db/views/40_money.sql, D-052)
CREATE TABLE IF NOT EXISTS yarago.tblpatientsappointmentbillingdetails (abilling_id int PRIMARY KEY, npatient_id int,
  nappointmentid int, totalamount numeric, discountamount numeric, billingdate timestamp, checknumber text, active int,
  id_billno text, id_nbillid int, cashamount numeric, cardamount numeric, chequeamount numeric, otherpaymentamt numeric,
  notherpaymenttype int, otherpaymentref text, currentdueamount numeric, ncollectedbyuser text);
CREATE TABLE IF NOT EXISTS yarago.tbl_payment_receptionist_new (trow_id int PRIMARY KEY, nbillid int, tdateofpayment timestamp,
  patient_id int, appoint_id int, chargetypeid int, chargepaidamount numeric, active int);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_chargetype (typeid int PRIMARY KEY, chargetypename text);
CREATE TABLE IF NOT EXISTS yarago.tbl_payment_lab (trow_id int PRIMARY KEY, nbillid int, tdateofpayment timestamp, patient_id int,
  appoint_id int, labtypeid int, labpaidamount numeric, active int);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_labstudies (id int PRIMARY KEY, labtestname text);
CREATE TABLE IF NOT EXISTS yarago.tbl_payment_injectionorlaser_procedure_for_billing (trow_id int PRIMARY KEY, nbillid int,
  tdateofpayment timestamp, patient_id int, appoint_id int, procedureid int, procedureamount numeric, active int);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_sub_surgical_types (subsurgid int PRIMARY KEY, subsurgicaltypename text);
CREATE TABLE IF NOT EXISTS yarago.tbl_payment_others_details (others_id int PRIMARY KEY, nbillid int, dateofpayment timestamp,
  npatient_id int, nappoint_id int, amount numeric, active int);
CREATE TABLE IF NOT EXISTS yarago.tblopticalpatientorders (orderid int PRIMARY KEY, billno bigint, npatid int, napptid int,
  isactive int, cancelleddate timestamp, inserteddate timestamp);
CREATE TABLE IF NOT EXISTS yarago.tblopticalpatientorderdetails (odid int PRIMARY KEY, orderid int, ncategoryid int,
  nproductid int, nsuppid int, nqty int, cancelledqty int, totamount numeric, taxamount numeric, discrsamt numeric,
  cancelledamt numeric, isactive int, inserteddate timestamp);
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_category (acatid int PRIMARY KEY, acategoryname text);
CREATE TABLE IF NOT EXISTS yarago.tblopticalpatientpayment (apayid int PRIMARY KEY, orderid int, npatid int, napptid int,
  atotalamount numeric, cashamount numeric, cardamount numeric, chequeamount numeric, chequeno text, otherpaymentid int,
  otherepaymentmode numeric, referencenumber text, refundamt numeric, isactive int, inserteddate timestamp,
  lastmodifieddate timestamp);
CREATE TABLE IF NOT EXISTS yarago.tblpatientopdrefunddetails (aoprefundid int PRIMARY KEY, npatientid int, napptid int,
  nbillid int, billno text, refundamount numeric, refundtype int, refundreason text, paymentmode text, isrefunded int,
  refunddate timestamp, cashamount numeric, chequeamount numeric, cardamount numeric, isactive int);
-- the Day collection's bill detail names pharmacy products (D-057)
CREATE TABLE IF NOT EXISTS yarago.tbl_mst_product (aprodid int PRIMARY KEY, aproductname text);
