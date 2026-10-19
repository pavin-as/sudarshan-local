import fs from 'node:fs/promises';
import {q,pool} from '../server/src/db.js';
try{
await q('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await q("SET LOCAL statement_timeout='120s'");
const src=await fs.readFile('outputs/spend-export.mts','utf8');
const sql=src.slice(src.indexOf('WITH bills AS ('),src.indexOf('`);',src.indexOf('WITH bills AS (')));
const top=await q(sql);const ids=new Set(top.map(r=>r.patient_id));
const people=await q(`SELECT p.patient_id,p.age_years FROM clinical.patient p WHERE coalesce(p.name,'') !~* '^\\s*(test|zz test)\\M'`);
const visits=await q(`SELECT npatient_id AS pid,aappoint_id AS vid,tappoint_date_time::date AS d FROM yarago.tblappointments WHERE nstatus_id=3 AND tappoint_date_time::date<=current_date ORDER BY tappoint_date_time,aappoint_id`);
const inj=await q(`SELECT patient_id AS pid,injection_id,treated_at::date AS d,eye FROM clinical.injection WHERE given AND treated_at::date<=current_date`);
const laser=await q(`SELECT patient_id AS pid,laser_id,treated_at::date AS d,eye FROM clinical.laser WHERE done IS NOT NULL AND treated_at::date<=current_date`);
const dx=await q(`SELECT k.patient_id AS pid,v.visit_date AS d,v.diagnosis_category AS cat FROM analytics.fact_visit v JOIN app.analytics_patient_key k USING(patient_key) WHERE v.completed AND v.visit_date<=current_date`);
const money=await q(`WITH bills AS(SELECT DISTINCT ON(id_nbillid) npatient_id AS pid,billingdate::date AS d,coalesce(cashamount,0)+coalesce(cardamount,0)+coalesce(chequeamount,0)+coalesce(otherpaymentamt,0) AS amount FROM yarago.tblpatientsappointmentbillingdetails WHERE coalesce(active,1)=1 AND id_nbillid IS NOT NULL AND billingdate::date<=current_date ORDER BY id_nbillid,abilling_id DESC) SELECT * FROM bills UNION ALL SELECT o.npatid,d.inserteddate::date,coalesce(d.totamount,0)-coalesce(d.cancelledamt,0) FROM yarago.tblopticalpatientorderdetails d JOIN yarago.tblopticalpatientorders o ON o.orderid=d.orderid WHERE coalesce(d.isactive,1)=1 AND coalesce(o.isactive,1)=1 AND o.cancelleddate IS NULL AND d.ncategoryid IN(3,5,6,7,8) AND d.inserteddate::date<=current_date`);
const [meta]=await q(`SELECT current_date::text AS today,(SELECT max(finished_at) FROM analytics.refresh_log WHERE status='ok') AS dx_refreshed,(SELECT count(*) FROM analytics.category_rule WHERE kind='diagnosis' AND NOT approved) AS unapproved_rules`);
await q('COMMIT');
const group=(rs:any[])=>{const m=new Map();for(const r of rs){if(!m.has(r.pid))m.set(r.pid,[]);m.get(r.pid).push(r);}return m;};
const vs=group(visits),is=group(inj),ls=group(laser),ds=group(dx),ms=group(money);
const day=(d:any)=>Math.floor(new Date(d).getTime()/86400000),today=day(meta.today);
const median=(a:number[])=>{a.sort((a,b)=>a-b);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
const quant=(a:number[],p:number)=>{a.sort((a,b)=>a-b);return a[Math.floor((a.length-1)*p)];};
const valid=people.filter(p=>vs.has(p.patient_id)||ms.has(p.patient_id));
function summary(ps:any[]){const n=ps.length;const pids=ps.map(p=>p.patient_id);return {n,median_visits:median(pids.map(id=>(vs.get(id)||[]).length)),median_age:median(ps.filter(p=>p.age_years!=null).map(p=>p.age_years)),any_injection:pids.filter(id=>is.has(id)).length,two_plus_injections:pids.filter(id=>(is.get(id)||[]).length>=2).length,any_laser:pids.filter(id=>ls.has(id)).length,both_eyes_injection:pids.filter(id=>{const eyes=(is.get(id)||[]).map(r=>r.eye);return eyes.includes('BE')||(eyes.includes('RE')&&eyes.includes('LE'));}).length,seen_last_180d:pids.filter(id=>(vs.get(id)||[]).some(r=>today-day(r.d)<=180)).length,median_years_observed:median(pids.map(id=>{const a=vs.get(id)||[];return a.length?(day(a.at(-1).d)-day(a[0].d))/365.25:0;})),median_injection_records:median(pids.map(id=>(is.get(id)||[]).length)),diagnoses:Object.entries(pids.reduce((a:any,id)=>{for(const cat of new Set((ds.get(id)||[]).map(r=>r.cat))){a[cat]=(a[cat]||0)+1;}return a;},{})).sort((a:any,b:any)=>b[1]-a[1])};}
const ts=summary(valid.filter(p=>ids.has(p.patient_id))),others=summary(valid.filter(p=>!ids.has(p.patient_id)));
// Retrospective early-warning test: first 90 days predict spending on days 91-365.
// Exclude the initial six months of records to reduce left-censoring, and require a full year of follow-up opportunity.
const cohort=valid.filter(p=>{const f=vs.get(p.patient_id)?.[0];return f&&f.d>='2021-07-01'&&day(f.d)<=today-365;}).map(p=>{
 const id=p.patient_id,first=day(vs.get(id)[0].d);const within=(r:any)=>day(r.d)>=first&&day(r.d)<=first+90;
 const v=(vs.get(id)||[]).filter(within),ii=(is.get(id)||[]).filter(within),dd=(ds.get(id)||[]).filter(within),mm=(ms.get(id)||[]);
 return {earlyVisits:v.length,earlyInj:ii.length,earlyLaser:(ls.get(id)||[]).filter(within).length,earlySpend:mm.filter(within).reduce((a,r)=>a+r.amount,0),futureSpend:mm.filter(r=>day(r.d)>first+90&&day(r.d)<=first+365).reduce((a,r)=>a+r.amount,0),retina:dd.some(r=>['Diabetic retinopathy / DME','Retinal vein occlusion','Age-related macular degeneration'].includes(r.cat)),diabetes:dd.some(r=>r.cat==='Diabetic retinopathy / DME'),rvo:dd.some(r=>r.cat==='Retinal vein occlusion'),amd:dd.some(r=>r.cat==='Age-related macular degeneration')};
});
const cutoff=quant(cohort.map(r=>r.futureSpend),.95),positive=(r:any)=>r.futureSpend>=cutoff;
const eligible=valid.filter(p=>{const f=vs.get(p.patient_id)?.[0];return f&&f.d>='2021-07-01'&&day(f.d)<=today-365;});
cohort.forEach((r:any,j)=>{const id=eligible[j].patient_id,first=day(vs.get(id)[0].d);r.injectionDates=new Set((is.get(id)||[]).filter(x=>day(x.d)>=first&&day(x.d)<=first+90).map(x=>x.d)).size;});
const rules:any={two_injections_90d:(r:any)=>r.earlyInj>=2,one_injection_90d:(r:any)=>r.earlyInj>=1,three_visits_90d:(r:any)=>r.earlyVisits>=3,retina_finding_90d:(r:any)=>r.retina,diabetic_retinopathy_90d:(r:any)=>r.diabetes,rvo_90d:(r:any)=>r.rvo,amd_90d:(r:any)=>r.amd,spend_10000_90d:(r:any)=>r.earlySpend>=10000,spend_20000_90d:(r:any)=>r.earlySpend>=20000,retina_plus_3_visits:(r:any)=>r.retina&&r.earlyVisits>=3,two_injections_or_retina_3_visits:(r:any)=>r.earlyInj>=2||(r.retina&&r.earlyVisits>=3)};
const positives=cohort.filter(positive).length;
rules.two_injection_dates_90d=(r:any)=>r.injectionDates>=2;
rules.two_injection_dates_or_20000=(r:any)=>r.injectionDates>=2||r.earlySpend>=20000;
rules.three_visit_dates_90d=(r:any)=>false;
delete rules.three_visit_dates_90d;
const evaluation=Object.entries(rules).map(([rule,fn]:any)=>{const flagged=cohort.filter(fn),hits=flagged.filter(positive).length;return {rule,flagged:flagged.length,hits,precision:flagged.length?hits/flagged.length:null,recall:hits/positives,median_future_spend:flagged.length?median(flagged.map(r=>r.futureSpend)):0};});
const topEarly=top.map(p=>{const f=vs.get(p.patient_id)?.[0];if(!f)return null;const first=day(f.d),within=(r:any)=>day(r.d)>=first&&day(r.d)<=first+90;return {v:(vs.get(p.patient_id)||[]).filter(within).length,i:(is.get(p.patient_id)||[]).filter(within).length,retina:(ds.get(p.patient_id)||[]).filter(within).some(r=>['Diabetic retinopathy / DME','Retinal vein occlusion','Age-related macular degeneration'].includes(r.cat))};}).filter(Boolean);
const result={meta,top50:ts,others,top_spend:{min:Math.min(...top.map(r=>r.total)),max:Math.max(...top.map(r=>r.total)),clinic:top.reduce((a,r)=>a+r.clinic,0),pharmacy:top.reduce((a,r)=>a+r.pharmacy,0)},top_first90:{n:topEarly.length,two_injections:topEarly.filter(r=>r.i>=2).length,three_visits:topEarly.filter(r=>r.v>=3).length,retina:topEarly.filter(r=>r.retina).length},early_test:{n:cohort.length,positive_count:positives,cutoff_future_spend:cutoff,baseline_rate:positives/cohort.length,definitions:'First recorded completed visit 2021-07-01 or later; at least 365 days before today. Features days 0-90; outcome spend days 91-365. Top 5% outcome threshold within this cohort. Same cohort calibration only; no independent validation.',evaluation}};
await fs.mkdir('outputs/sampada-vip-analysis',{recursive:true});await fs.writeFile('outputs/sampada-vip-analysis/aggregate-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await pool.end();}
