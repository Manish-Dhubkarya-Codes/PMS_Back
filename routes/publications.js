var express = require('express');
var router = express.Router();
var pool = require("./pool")
// var upload = require("./multer");

router.post('/submit_publication', function (req, res, next) {
    console.log("REQQQQQQQQQQQQQQQQQ",req)
    try {
        pool.query("insert into publications (sourceTitle, citeScore, highestPercentile, citations, documents, cited) values(?,?,?,?,?,?)", [req.body.sourceTitle, req.body.citeScore, req.body.highestPercentile, req.body.citations, req.body.documents, req.body.cited], function (error, result) {            
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
router.post('/update_publication', function (req, res, next) {
    console.log(req.body)
    console.log(req.file)
    try {
        pool.query("update publications set sourceTitle=?, citeScore=?, highestPercentile=?, citations=?, documents=?, cited=? where publicationId=?", [req.body.sourceTitle, req.body.citeScore, req.body.highestPercentile, req.body.citations, req.body.documents, req.body.cited, req.body.publicationId], function (error, result) {
            if (error) {
                console.log(error)
               return res.status(500).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
               return res.status(200).json({ status: true, message: "Publication Updated Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});

router.post('/delete_publication', function (req, res, next) {
    console.log(req.body)
    console.log(req.file)
    try {
        pool.query("delete from publications where publicationId=?", [req.body.publicationId], function (error, result) {
            if (error) {
                console.log(error)
               return res.status(400).json({ status: false, message: "DataBase Error, Plz Contact DataBase Admin" })
            }
            else {
               return res.status(200).json({ status: true, message: "publication Deleted Successfully!" })
            }
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })

    }
});
router.get("/display_all_publications", function(req, res, next){
    
    try {
        pool.query("select * from publications", function (error, result) {
            if (error) {
                console.log(error)
               return res.status(400).json({status: false, message: "DataBase Error, Plz Contact DataBase Admin"})
            }
            else {
               return res.status(200).json({data:result, status: true, message: "Success!" })
            }
            
        })
    }
    catch (e) {
      return  res.status(500).json({ status: false, message: "Server Error...!" })
    }
})

module.exports = router;