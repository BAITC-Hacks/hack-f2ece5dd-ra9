export interface Segment {id:string; speakerId:string; text:string; start:number|null; end:number|null; language:string|null}
export interface Task {id:string; title:string; assignee:string|null; deadline:string|null; reviewed:boolean; completed:boolean; sourceId:string|null; quote:string; start:number|null; needsReview:boolean}
export interface Meeting {schemaVersion:number; id:string; title:string; date:string; timezone:string; participants:string[]; speakers:{id:string; name:string; color:number}[]; segments:Segment[]; tasks:Task[]; summary:string; decisions:string[]; questions:string[]; keyPoints?:string[]; mode:'demo'|'import'|'real'; status:'ready'|'partial'|'processing'|'error'|'awaiting'; createdAt:string; audioName?:string; audioBlob?:Blob; requestId?:string; jobId?:string|null; stage?:string; progress?:number|null; error?:string; updatedAt?:string}
export interface Capabilities {asr:boolean; analyzer:boolean; extensions:string[]; maxBytes:number; error?:string}

