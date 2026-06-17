var express = require('express');
var router = express.Router();
var pool = require("./pool")
var upload = require("./multer");

router.post('/submit_admin', upload.single("adminPic"), function (req, res, next) {
    console.log("REQQQQQQQQQQQQQQQQQ",req.body)
    try {
        pool.query("insert into admin (adminName, adminMail, adminPhone, adminPassword, adminPic) values(?,?,?,?,?)", [req.body.adminName, req.body.adminMail, req.body.adminPhone, req.body.adminPassword, req.file.filename], function (error, result) {            
            if (error) {
                console.log("ERRRRRRRRR",error)
               return res.status(400).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
              
               return res.status(200).json({ status: true, message: "Conference Submitted Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })
    }
});

router.post('/check_admin_signin', function(req, res, next) {
     try {
  pool.query('select * from admin where (adminName=? or adminMail=?) and adminPassword=?',[req.body.adminName,req.body.adminName,req.body.adminPassword],function(error,result){
   if(error)
   { res.status(400).json({message:'Database Error',status:false})}
   else
   { 
    if(result.length==1)
    res.status(200).json({message:'Successfully sign in',status:true,data:result[0]})
    else
    res.status(400).json({message:'Invalid Emailid/Mobileno/Password',status:false})

}
  })
  }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});

module.exports = router;