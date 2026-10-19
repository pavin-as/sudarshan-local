import fs from 'node:fs';
import { q, pool } from '../../server/src/db.js';
import { riskTier } from '../../server/src/services/followupRisk.js';
const source=fs.readFileSync('server/src/routes/followups.ts','utf8');
const start=source.indexOf('`SELECT fc.patient_id');
const end=source.indexOf('`, [f.view',start);
const template=source.slice(start+1,end);
const stateFilter='NOT fc.came_back AND fc.due_date < current_date AND fc.days_overdue <= $1::int';
const CLOSING=['booked','declined','wrong_number','not_needed','moved_away','deceased'];
const sql=new Function('stateFilter','f','CLOSING','return `'+template+'`;')(stateFilter,{view:'to_call'},CLOSING);
try {
 const rows=await q(sql,[90]);
 const urgent=rows.filter((r:any)=>riskTier({ageYears:r.ageYears,condition:r.condition,lastInjectionDays:r.inj_days,lastInjection:null,lastLaserDays:r.las_days,lastLaser:null,diabetes:r.diabetes}).tier===1).sort((a:any,b:any)=>a.daysOverdue-b.daysOverdue);
 for(const r of urgent){
   const [v]=await q('SELECT doctor_remarks FROM clinical.visit WHERE visit_id=$1',[r.followupId ? (await q('SELECT from_visit_id FROM clinical.followup_current WHERE patient_id=$1',[r.patientId]))[0].from_visit_id:null]);
   r.remark=r.lastNote || r.comments || v?.doctor_remarks || null;
 }
 const [meta]=await q('SELECT current_date::text AS date');
 fs.writeFileSync('outputs/rop-export/data.json',JSON.stringify({date:meta.date,rows:urgent.map((r:any)=>({name:r.name,mrd:r.mrd,mobile:r.mobile,lastVisit:r.fromVisitDate,followup:r.dueDate,remark:r.remark})),count:urgent.length}));
 console.log(JSON.stringify({count:urgent.length,date:meta.date,missingContacts:urgent.filter((r:any)=>!r.mobile).length,missingRemarks:urgent.filter((r:any)=>!r.remark).length}));
} finally {await pool.end();}
