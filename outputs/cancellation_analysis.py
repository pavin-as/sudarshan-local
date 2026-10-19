from pathlib import Path
import json,csv,datetime
import psycopg
from psycopg.rows import dict_row
from dotenv import dotenv_values
ROOT=Path(__file__).resolve().parent.parent
c=dotenv_values(ROOT/'.env')
base="""WITH pm AS (SELECT upper(trim(mrd)) mrd,min(patient_id) pid FROM clinical.patient WHERE nullif(trim(mrd),'') IS NOT NULL GROUP BY 1 HAVING count(*)=1), b AS (
SELECT a.*,coalesce(a.patient_id,pm.pid) resolved_pid,
CASE WHEN coalesce(a.patient_id,pm.pid) IS NOT NULL THEN 'p:'||coalesce(a.patient_id,pm.pid)::text WHEN nullif(trim(a.mrd),'') IS NOT NULL THEN 'm:'||upper(trim(a.mrd)) ELSE 'unlinked:'||a.id::text END pk
FROM app.appointments a LEFT JOIN pm ON upper(trim(a.mrd))=pm.mrd
WHERE a.patient_name !~* '^(ZZ Test|TEST)' ), g AS (
SELECT pk,max(resolved_pid) pid,count(*) total,count(*) FILTER(WHERE status='cancelled') cancellations,
max(appointment_date) FILTER(WHERE status='cancelled') last_cancelled_appointment,
max(cancelled_at) FILTER(WHERE status='cancelled') last_cancellation_recorded,
count(*) FILTER(WHERE status='cancelled' AND cancelled_at IS NULL) missing_cancel_time,
count(*) FILTER(WHERE appointment_date < current_date) past_bookings,
count(*) FILTER(WHERE appointment_date < current_date AND status='cancelled') past_cancellations
FROM b GROUP BY pk) """
with psycopg.connect(host=c['PG_HOST'],port=c['PG_PORT'],dbname=c['PG_DB'],user=c['PG_APP_USER'],password=c['PG_APP_PASSWORD'],options='-c default_transaction_read_only=on -c statement_timeout=90000 -c TimeZone=Asia/Kolkata',row_factory=dict_row) as db:
 def q(s): return db.execute(s).fetchall()
 rows=q(base+"""SELECT g.*,coalesce(p.name,x.patient_name) name,coalesce(p.mrd,x.mrd) mrd,coalesce(nullif(p.mobile,''),x.phone) phone,
 v.last_visit FROM g
 LEFT JOIN clinical.patient p ON p.patient_id=g.pid
 LEFT JOIN LATERAL(SELECT patient_name,mrd,phone FROM b WHERE b.pk=g.pk ORDER BY appointment_date DESC,id DESC LIMIT 1)x ON true
 LEFT JOIN LATERAL(SELECT max(visit_date) last_visit FROM clinical.visit WHERE patient_id=g.pid AND status_id IN(1,2,3) AND visit_date<=current_date)v ON true
 WHERE cancellations>0 ORDER BY cancellations DESC,last_cancelled_appointment DESC,pk LIMIT 20""")
 summary={}
 summary['status']=q(base+"SELECT status,count(*) n,min(appointment_date) first_date,max(appointment_date) last_date FROM b GROUP BY 1 ORDER BY 2 DESC")
 summary['repeat']=q(base+"SELECT count(*) patients,sum(cancellations) cancellations,count(*) FILTER(WHERE cancellations>=2) repeat_patients,sum(cancellations) FILTER(WHERE cancellations>=2) repeat_cancellations,max(cancellations) maximum FROM g WHERE cancellations>0")
 summary['top20']={'cancellations':sum(r['cancellations'] for r in rows),'counts':[r['cancellations'] for r in rows],'missing_cancel_timestamps':sum(r['missing_cancel_time'] for r in rows)}
 summary['timing']=q(base+"SELECT CASE WHEN cancelled_at IS NULL THEN 'Unknown' WHEN appointment_date-cancelled_at::date<0 THEN 'After appointment date' WHEN appointment_date-cancelled_at::date=0 THEN 'Same day' WHEN appointment_date-cancelled_at::date=1 THEN 'One day before' WHEN appointment_date-cancelled_at::date<=7 THEN '2-7 days before' ELSE '8+ days before' END timing,count(*) n FROM b WHERE status='cancelled' GROUP BY 1 ORDER BY 2 DESC")
 summary['weekday']=q(base+"SELECT to_char(appointment_date,'Dy') weekday,count(*) bookings,count(*) FILTER(WHERE status='cancelled') cancellations,round(100.0*count(*) FILTER(WHERE status='cancelled')/count(*),1) rate FROM b WHERE appointment_date<current_date GROUP BY 1 ORDER BY rate DESC")
 summary['monthly']=q(base+"SELECT to_char(appointment_date,'YYYY-MM') AS period,count(*) bookings,count(*) FILTER(WHERE status='cancelled') cancellations,round(100.0*count(*) FILTER(WHERE status='cancelled')/count(*),1) rate FROM b WHERE appointment_date<current_date GROUP BY 1 ORDER BY 1")
 summary['identity']=q(base+"SELECT count(*) FILTER(WHERE resolved_pid IS NULL) unlinked,count(*) FILTER(WHERE pk LIKE 'unlinked:%') unidentified,count(*) FILTER(WHERE nullif(trim(cancel_reason),'') IS NOT NULL) reasons_present FROM b WHERE status='cancelled'")
 summary['reasons']=q("SELECT cancel_reason_group,count(*) n FROM analytics.fact_appointment WHERE cancelled GROUP BY 1 ORDER BY 2 DESC")
 summary['sync']=q("SELECT source,finished_at,status FROM app.import_runs ORDER BY finished_at DESC LIMIT 1")
 headers=['Rank','Name','MRD number','Contact number','Number of cancellations','Last visit','Last cancelled appointment','Last recorded cancellation (IST)','Bookings in history','Cancellations without timestamp']
 data=[]
 for i,r in enumerate(rows,1):
  data.append([i,r['name'],r['mrd'] or 'Not recorded',r['phone'] or 'Not recorded',r['cancellations'],str(r['last_visit'] or 'No linked attended visit'),str(r['last_cancelled_appointment']),str(r['last_cancellation_recorded'] or 'Not recorded'),r['total'],r['missing_cancel_time']])
 out=ROOT/'outputs'
 with (out/'top20_cancellations.csv').open('w',newline='',encoding='utf-8-sig') as f:
  w=csv.writer(f);w.writerow(headers);w.writerows(data)
 text='# Top 20 patients by recorded cancellations\n\nGenerated '+str(datetime.datetime.now())+' (clinic computer).\n\nSource: local PostgreSQL app.appointments and clinical.patient/visit. All available booking history; TEST records excluded. Count is cancelled booking rows, not cancellation events. Identity grouped by patient ID, then unique MRD mapping, then normalized MRD; records with neither remain separate. Ties ordered by latest cancelled appointment date.\n\nLast visit means latest Yarago attended visit (status 1, 2 or 3), through today. Last cancelled appointment is the date of the slot cancelled. Last recorded cancellation is the latest available timestamp of the cancellation action; missing timestamps mean the actual latest action cannot be guaranteed. Current-status data cannot recover cancellations later restored. Reasons do not establish patient responsibility.\n\n'
 text+='| '+' | '.join(headers)+' |\n|'+'|'.join(['---']*len(headers))+'|\n'
 for row in data:text+='| '+' | '.join(str(v).replace('|','/').replace('\n',' ') for v in row)+' |\n'
 (out/'top20_cancellations.local.md').write_text(text,encoding='utf-8')
 print(json.dumps(summary,default=str))
 print('Report written locally; 20 rows, identifiers not printed.')

