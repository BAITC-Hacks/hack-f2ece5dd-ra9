import {speakerName,timecode,dateLabel,reviewNeeded} from './domain.js';
const encode=new TextEncoder();
const xml=s=>String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return(n^0xffffffff)>>>0;}
function join(chunks){const out=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}return out;}
function header(size,fields){const a=new Uint8Array(size),v=new DataView(a.buffer);for(const[o,n,length]of fields)length===4?v.setUint32(o,n,true):v.setUint16(o,n,true);return a;}
// Standards-compliant uncompressed ZIP. Office documents are small; no library needed.
export function zip(files){
 const local=[],central=[];let offset=0;
 for(const[name,content]of Object.entries(files)){
  const n=encode.encode(name),data=encode.encode(content),crc=crc32(data);
  const l=header(30,[[0,0x04034b50,4],[4,20,2],[6,0x800,2],[14,crc,4],[18,data.length,4],[22,data.length,4],[26,n.length,2]]);
  local.push(l,n,data);
  central.push(header(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x800,2],[16,crc,4],[20,data.length,4],[24,data.length,4],[28,n.length,2],[42,offset,4]]),n);
  offset+=l.length+n.length+data.length;
 }
 const c=join(central),count=Object.keys(files).length;
 return join([...local,c,header(22,[[0,0x06054b50,4],[8,count,2],[10,count,2],[12,c.length,4],[16,offset,4]])]);
}
const p=(text,style='Normal')=>'<w:p><w:pPr><w:pStyle w:val="'+style+'"/></w:pPr>'+String(text??'').split('\n').map((line,k)=>(k?'<w:r><w:br/></w:r>':'')+'<w:r><w:t xml:space="preserve">'+xml(line)+'</w:t></w:r>').join('')+'</w:p>';
const cell=(text,width,bold=false)=>'<w:tc><w:tcPr><w:tcW w:w="'+width+'" w:type="dxa"/>'+(bold?'<w:shd w:fill="EDF2FA"/>':'')+'<w:vAlign w:val="top"/></w:tcPr>'+p(text,bold?'TableHeader':'TableText')+'</w:tc>';
export function docxFiles(m){
 let body=p('ПРОТОКОЛ СОВЕЩАНИЯ','Eyebrow')+p(m.title,'Title');
 if(m.mode==='demo')body+=p('ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. Вымышленный пример, не результат распознавания аудио.','Notice');
 if(m.status==='partial')body+=p('ЧАСТИЧНЫЙ РЕЗУЛЬТАТ. Проверьте полноту протокола.','Notice');
 body+=p('Дата: '+dateLabel(m.date)+' · Часовой пояс: '+m.timezone,'Meta');
 const participants=[...new Set(m.participants.length?m.participants:m.speakers.map(s=>s.name))];
 body+=p('Участники: '+(participants.join(', ')||'Не указаны'),'Meta')+p('Голоса в транскрипте: '+m.speakers.map((s,k)=>'Голос '+(k+1)+' — '+s.name).join('; '),'Meta')+p('Краткие итоги','Heading1')+p(m.summary||'Не сформированы');
 if(m.keyPoints?.length)body+=m.keyPoints.map(x=>p('• '+x)).join('');
 if(m.decisions.length)body+=p('Принятые решения','Heading1')+m.decisions.map((x,k)=>p((k+1)+'. '+x)).join('');
 if(m.questions.length)body+=p('Требует уточнения','Heading1')+m.questions.map(x=>p('• '+x)).join('');
 body+=p('Поручения','Heading1');
 const widths=[480,3860,1550,1450,1900];
 const headings=['№','Поручение / основание','Ответственный','Срок','Проверка / выполнение'];
 const rows='<w:tr><w:trPr><w:tblHeader/></w:trPr>'+headings.map((x,k)=>cell(x,widths[k],true)).join('')+'</w:tr>'+
 m.tasks.map((t,k)=>'<w:tr>'+[
 String(k+1),t.title+(t.quote?'\nИсточник'+(t.start!==null?' ['+timecode(t.start)+']':'')+': «'+t.quote+'»':''),
 t.assignee||'Не указан',t.deadline?dateLabel(t.deadline):'Не указан',
 (t.reviewed?'Проверено секретарём':'Требует проверки')+(reviewNeeded(t)&&t.reviewed?'\nЕсть незаполненные поля':'')+'\n'+(t.completed?'Выполнено':'Не выполнено')
 ].map((x,n)=>cell(x,widths[n])).join('')+'</w:tr>').join('');
 body+=m.tasks.length?'<w:tbl><w:tblPr><w:tblW w:w="9240" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(x=>'<w:'+x+' w:val="single" w:sz="4" w:color="DDE4EE"/>').join('')+'</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>'+widths.map(w=>'<w:gridCol w:w="'+w+'"/>').join('')+'</w:tblGrid>'+rows+'</w:tbl>':p('Поручения не выделены.');
 body+=p('Проверка секретарём подтверждает содержание поручения и не означает его выполнение.','Meta');
 body+='<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1250" w:right="1333" w:bottom="1250" w:left="1333" w:header="500" w:footer="500"/></w:sectPr>';
 const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:color w:val="34445B"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="280" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'+
 [['Normal','',22,'34445B',false],['Title','',38,'243751',true],['Heading1','',26,'3563B0',true],['Meta','',18,'8190A4',false],['Eyebrow','',17,'5D7BB0',true],['Notice','',20,'A87830',true],['TableText','',19,'455671',false],['TableHeader','',18,'3D5B84',true]].map(([id,,size,color,bold])=>'<w:style w:type="paragraph" w:styleId="'+id+'"><w:name w:val="'+id+'"/><w:pPr>'+(['Title','Heading1'].includes(id)?'<w:keepNext/><w:spacing w:before="200" w:after="160"/>':'')+'</w:pPr><w:rPr><w:sz w:val="'+size+'"/><w:color w:val="'+color+'"/>'+(bold?'<w:b/>':'')+'</w:rPr></w:style>').join('')+'</w:styles>';
 return {
 '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
 '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
 'word/document.xml':'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'+body+'</w:body></w:document>',
 'word/styles.xml':styles,
 'word/_rels/document.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
 'word/footer1.xml':'<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'+p('ПРОТОКОЛ · rA9    |    Локальный документ · требует проверки','Meta')+'</w:ftr>'
 };
}
function download(filename,data,type){
 const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function filename(m,ext){return(m.mode==='demo'?'Демо — ':'')+m.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,90)+'.'+ext;}
export const downloadDocx=m=>download(filename(m,'docx'),zip(docxFiles(m)),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
export function exportData(m){
 return {schema_version:2,demo:m.mode==='demo',title:m.title,date:m.date,timezone:m.timezone,participants:m.participants,status:m.status,summary:m.summary,decisions:m.decisions,questions:m.questions,speakers:m.speakers,
 segments:m.segments.map(s=>({speaker:s.speakerId,start:s.start,end:s.end,text:s.text,language:s.language})),
 tasks:m.tasks.map(t=>({title:t.title,responsible:t.assignee,deadline:t.deadline,reviewed:t.reviewed,completed:t.completed,requires_review:reviewNeeded(t),evidence:{quote:t.quote,start:t.start}}))};
}
export const downloadJson=m=>download(filename(m,'json'),JSON.stringify(exportData(m),null,2),'application/json;charset=utf-8');
export function downloadTranscript(m){download(filename(m,'txt'),'\ufeff'+[m.title,dateLabel(m.date)+' · '+m.timezone,m.mode==='demo'?'ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ — не результат распознавания.':'','',...m.segments.map(s=>(s.start===null?'':'['+timecode(s.start)+'] ')+speakerName(m,s.speakerId)+': '+s.text)].join('\r\n'),'text/plain;charset=utf-8');}
