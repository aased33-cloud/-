'use strict';
document.addEventListener('keydown',event=>{
 const el=event.target;if(!(el instanceof HTMLInputElement)||event.isComposing||event.keyCode===229||!el.matches('.weekly-grid-input,input.plan-slot'))return;
 if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter'].includes(event.key))return;
 if((event.key==='ArrowLeft'&&(el.selectionStart!==0||el.selectionEnd!==0))||(event.key==='ArrowRight'&&(el.selectionStart!==el.value.length||el.selectionEnd!==el.value.length)))return;
 const cell=el.closest('td'),row=cell?.parentElement,table=row?.closest('table');if(!table)return;const cells=[...row.children],idx=cells.indexOf(cell);let target;
 if(event.key==='ArrowLeft'||event.key==='ArrowRight'){const next=cells[idx+(event.key==='ArrowLeft'?-1:1)];target=next?.querySelector('input')}
 else{let next=event.key==='ArrowUp'?row.previousElementSibling:row.nextElementSibling;while(next&&!target){target=next.children[idx]?.querySelector('input');next=event.key==='ArrowUp'?next.previousElementSibling:next.nextElementSibling}}
 if(target){event.preventDefault();target.focus();target.select()}
});
