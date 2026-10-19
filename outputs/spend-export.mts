import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {q,pool} from '../server/src/db.js';
const require=createRequire('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {Workbook,SpreadsheetFile}=require('@oai/artifact-tool');
const dir='D:/Sudarshan/app/outputs/sampada-top50';
await fs.mkdir(dir,{recursive:true});
try {
 await q('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await q("SET LOCAL statement_timeout='90s'");
 const rows=await q(`WITH bills AS (
 SELECT DISTINCT ON(id_nbillid) npatient_id AS patient_id,
 coalesce(cashamount,0)+coalesce(cardamount,0)+coalesce(chequeamount,0)+coalesce(otherpaymentamt,0) AS amount
 FROM yarago.tblpatientsappointmentbillingdetails
 WHERE coalesce(active,1)=1 AND id_nbillid IS NOT NULL AND billingdate::date<=current_date
 ORDER BY id_nbillid,abilling_id DESC
 ), clinic AS (SELECT patient_id,sum(amount) AS amount FROM bills GROUP BY 1), pharmacy AS (
 SELECT o.npatid AS patient_id,sum(coalesce(d.totamount,0)-coalesce(d.cancelledamt,0)) AS amount
 FROM yarago.tblopticalpatientorderdetails d JOIN yarago.tblopticalpatientorders o ON o.orderid=d.orderid
 WHERE coalesce(d.isactive,1)=1 AND coalesce(o.isactive,1)=1 AND o.cancelleddate IS NULL
 AND d.ncategoryid IN(3,5,6,7,8) AND d.inserteddate::date<=current_date GROUP BY 1
 ), visits AS (
 SELECT npatient_id AS patient_id,count(*) AS visits,max(tappoint_date_time::date) AS last_visit
 FROM yarago.tblappointments WHERE nstatus_id=3 AND tappoint_date_time::date<=current_date GROUP BY 1
 ) SELECT p.patient_id,p.name,p.mrd,p.mobile,coalesce(c.amount,0) AS clinic,coalesce(ph.amount,0) AS pharmacy,
 coalesce(c.amount,0)+coalesce(ph.amount,0) AS total,coalesce(v.visits,0) AS visits,v.last_visit
 FROM clinical.patient p LEFT JOIN clinic c USING(patient_id) LEFT JOIN pharmacy ph USING(patient_id)
 LEFT JOIN visits v USING(patient_id)
 WHERE coalesce(c.amount,0)+coalesce(ph.amount,0)>0 AND coalesce(p.name,'') !~* '^\\s*(test|zz test)\\M'
 ORDER BY total DESC,p.patient_id LIMIT 50`);
 const [meta]=await q(`SELECT current_date::text AS asof,(SELECT min(billingdate)::date::text FROM yarago.tblpatientsappointmentbillingdetails WHERE coalesce(active,1)=1) AS first_bill,(SELECT max(billingdate)::date::text FROM yarago.tblpatientsappointmentbillingdetails WHERE coalesce(active,1)=1) AS last_bill,(SELECT max(inserteddate)::date::text FROM yarago.tblopticalpatientorderdetails WHERE ncategoryid IN(3,5,6,7,8)) AS last_pharmacy`);
 await q('COMMIT');
 if(rows.length!==50||new Set(rows.map(r=>r.patient_id)).size!==50||rows.some((r,i)=>Math.abs(r.total-r.clinic-r.pharmacy)>.01||(i>0&&r.total>rows[i-1].total))) throw Error('Ranking validation failed');
 const wb=Workbook.create();
 const s=wb.worksheets.add('Top 50 patients'), b=wb.worksheets.add('Spending detail');
 const headers=['Name','MRD number','Phone number','Total amount (INR)','Total number of visits','Last visit date'];
 const date=(v:any)=>v?new Date(v+'T00:00:00Z'):null;
 s.getRange('A2').values=[['Sampada | Top 50 patients by total spending']];
 s.getRange('A3').values=[[`All available history through ${meta.asof} | Highest spending first`]];
 s.getRange('A5:F5').values=[headers];
 s.getRange('A6:F55').values=rows.map((r,i)=>[r.name,r.mrd?String(r.mrd):null,r.mobile?String(r.mobile):null,r.total,r.visits,date(r.last_visit)]);
 b.getRange('A2').values=[['Spending breakdown and report definitions']];
 b.getRange('A5:E5').values=[['Name','MRD number','Clinic payments (INR)','Pharmacy net sales (INR)','Total amount (INR)']];
 b.getRange('A6:E55').values=rows.map(r=>[r.name,r.mrd?String(r.mrd):null,r.clinic,r.pharmacy,r.total]);
 const notes=[
 'Period: all available records through '+meta.asof+'. Clinic bills: '+meta.first_bill+' to '+meta.last_bill+'. Latest pharmacy sale: '+meta.last_pharmacy+'.',
 'Clinic payments: cash + card + cheque + other payment, latest active row per bill ID. Includes consultation, investigations, procedures and other clinic charges.',
 'Pharmacy: active sale lines less returned amounts, including tax and after discount; categories 3, 5, 6, 7, 8. Cancelled orders excluded. Optical purchases excluded.',
 'Pharmacy uses net sales, which may differ from cash collected where a pharmacy balance remains unpaid. Clinic payments use recorded collections.',
 'Visits: completed Yarago appointments (status 3); separate appointment IDs count separately even on the same date. Pharmacy-only transactions do not count as visits.',
 'Last visit: latest completed appointment. Patients are grouped by permanent Yarago patient ID; different registrations are not merged by name or phone.',
 'Source: read-only snapshot of local PostgreSQL Yarago mirror; no patient data sent to cloud services. Blank identifiers mean not recorded.',
 ];
 b.getRange('G5').values=[['Report definitions / source']];
 b.getRange('G6:G12').values=notes.map(n=>[n]);
 b.getRange('G5:G12').format.columnWidth=100;
 b.getRange('G6:G12').format.wrapText=true;
 for(const sh of [s,b]){
 sh.showGridLines=false;
 const end=sh===s?'F':'E';
 sh.getRange(`A2:${end}55`).format.font={name:'Arial',size:11};
 sh.getRange('A2').format.font={bold:true,size:16};
 sh.getRange(`A5:${end}55`).format.rowHeight=30;
 sh.getRange(`A5:${end}5`).format.fill='#24465A';
 sh.getRange(`A5:${end}5`).format.font={bold:true,color:'#FFFFFF'};
 sh.getRange(`A5:${end}5`).format.wrapText=true;
 sh.getRange(`A5:${end}5`).format.rowHeight=42;
 sh.getRange(`A5:${end}55`).format.verticalAlignment='center';
 sh.getRange('A5:A55').format.columnWidth=39;
 sh.getRange('B5:B55').format.columnWidth=18;
 sh.getRange('B6:B55').setNumberFormat('@');
 sh.tables.add(`A5:${end}55`,true,sh===s?'TopPatients':'SpendingDetail');
 sh.freezePanes.freezeRows(5);
 }
 s.getRange('C5:C55').format.columnWidth=22;s.getRange('C6:C55').setNumberFormat('@');
 s.getRange('D5:D55').format.columnWidth=24;s.getRange('D6:D55').setNumberFormat('#,##0.00');
 s.getRange('E5:E55').format.columnWidth=24;s.getRange('E6:E55').setNumberFormat('#,##0');
 s.getRange('F5:F55').format.columnWidth=22;s.getRange('F6:F55').setNumberFormat('yyyy-mm-dd');
 b.getRange('C5:E55').format.columnWidth=27;b.getRange('C6:E55').setNumberFormat('#,##0.00');
 b.getRange('G6:G12').format.rowHeight=65;
 wb.recalculate();
 await wb.inspect({kind:'table',range:'Top 50 patients!A5:F55',include:'values',tableMaxRows:50,tableMaxCols:6});
 const vals=s.getRange('A6:F55').values;
 if(vals.some((r:any,i:number)=>r[1]!==rows[i].mrd||r[3]!==rows[i].total||r[4]!==rows[i].visits))throw Error('Workbook validation failed');
 // Render an equivalent de-identified copy so no identity leaves the clinic during visual QA.
 const out=dir+'/Sampada_Top_50_Patients.xlsx';
 await (await SpreadsheetFile.exportXlsx(wb)).save(out);
 s.getRange('A6:C55').values=rows.map((r,i)=>['Patient '+String(i+1).padStart(2,'0'),'MRD withheld','Phone withheld']);
 b.getRange('A6:B55').values=rows.map((r,i)=>['Patient '+String(i+1).padStart(2,'0'),'MRD withheld']);
 await fs.writeFile(dir+'/deidentified-preview.png',new Uint8Array(await(await wb.render({sheetName:s.name,range:'A2:F12',scale:1.3,format:'png'})).arrayBuffer()));
 await fs.writeFile(dir+'/deidentified-detail-preview.png',new Uint8Array(await(await wb.render({sheetName:b.name,range:'A2:G12',scale:1,format:'png'})).arrayBuffer()));
 console.log(JSON.stringify({exported:out,rows:rows.length,missingPhones:rows.filter(r=>!r.mobile).length,missingMRD:rows.filter(r=>!r.mrd).length,missingLastVisit:rows.filter(r=>!r.last_visit).length,...meta}));
}finally{await pool.end();}
